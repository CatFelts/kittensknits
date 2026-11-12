import { NextResponse } from "next/server";
import type Stripe from "stripe";

import {
  cancelOrder,
  getOrderBySessionId,
  markOrderPaid,
  markOrderProcessing,
} from "@/lib/db";
import { customerDetails, isStripeConfigured, stripe } from "@/lib/stripe";

/**
 * Stripe's webhook. This is the ONLY authority on whether an order is paid —
 * the browser redirect can be closed, faked, or lost, but this cannot.
 *
 * Local testing:
 *   stripe listen --forward-to localhost:3000/api/stripe/webhook
 */

// Never cache, and never pre-render.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!isStripeConfigured || !secret) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  // The signature is computed over the RAW body, so read text, not json.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid signature";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      const orderId = await orderIdFor(session);
      if (!orderId) break;

      const { email, shipping } = customerDetails(session);
      if (session.payment_status === "paid") {
        await markOrderPaid(orderId, email, shipping);
      } else {
        // Checkout finished with a slow payment method (e.g. bank transfer).
        // Keep holding the items until async_payment_succeeded or _failed.
        await markOrderProcessing(orderId, email, shipping);
      }
      break;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      // Abandoned, or the slow payment bounced. Put the items back on sale.
      const orderId = await orderIdFor(event.data.object);
      if (orderId) await cancelOrder(orderId);
      break;
    }
    default:
      // Everything else is acknowledged and ignored.
      break;
  }

  return NextResponse.json({ received: true });
}

async function orderIdFor(
  session: Stripe.Checkout.Session,
): Promise<string | null> {
  const order = await getOrderBySessionId(session.id);
  return order?.id ?? session.client_reference_id ?? null;
}
