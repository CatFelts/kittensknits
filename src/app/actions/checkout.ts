"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type Stripe from "stripe";

import { clearCart, getCart } from "@/lib/cart";
import { checkoutMode } from "@/lib/checkout-mode";
import {
  cancelOrder,
  createOrder,
  getOrder,
  markOrderPaid,
  type OrderItem,
  RESERVATION_MINUTES,
} from "@/lib/db";
import { CHECKOUT_COOKIE, ownPendingOrderId } from "@/lib/inventory";
import { CURRENCY } from "@/lib/money";
import { SHIPPING, shippingFor } from "@/lib/shipping";
import { siteUrl, stripe } from "@/lib/stripe";

function newOrderId(): string {
  return "KK-" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
}

/**
 * Turn the cart into an order.
 *
 * Which path runs is decided by checkoutMode(), the SAME function the cart page
 * uses to choose which button to render. That shared source of truth matters:
 * if this branched on `isStripeConfigured` directly it could disagree with the
 * page — the cart could offer an email link while this tried to charge a card,
 * or offer a card button on a host with nowhere to record the sale.
 *
 *   stripe   -> create a hosted Checkout Session, save the order as 'pending',
 *               hand the customer to Stripe. The webhook marks it paid.
 *   demo     -> record the order as paid immediately, so the prototype is
 *               clickable end to end without any account setup.
 *   enquiry  -> nothing to do here; the cart page renders a mailto link instead.
 *
 * Prices come from the catalog, never from the request.
 */
/**
 * A shopper who went to Stripe, came back without paying, and is checking out
 * again still holds the items from their first attempt. Close that first
 * Stripe session (so it can no longer be paid) and drop its hold, so the
 * same skein is never held, or paid for, twice.
 */
async function releaseEarlierCheckout(): Promise<void> {
  const previousId = await ownPendingOrderId();
  if (!previousId) return;

  const previous = await getOrder(previousId);
  if (previous?.status !== "pending" || !previous.stripe_session_id) return;

  try {
    await stripe().checkout.sessions.expire(previous.stripe_session_id);
    await cancelOrder(previous.id);
  } catch {
    // Stripe refuses to expire a session that already completed or expired.
    // Either way the webhook settles that order; leave it alone.
  }
}

export async function checkout(): Promise<void> {
  if (checkoutMode() === "stripe") {
    await releaseEarlierCheckout();
  }

  const cart = await getCart();

  if (cart.items.length === 0) {
    redirect("/cart?error=empty");
  }
  if (cart.adjusted) {
    // Stock changed under us while they were shopping. Show the trimmed cart
    // and make them confirm rather than silently charging for something else.
    redirect("/cart?error=changed");
  }

  const items: OrderItem[] = cart.items.map((i) => ({
    sku: i.sku,
    name: i.name,
    qty: i.qty,
    unitPriceCents: i.unitPriceCents,
  }));

  const mode = checkoutMode();
  const shippingCents = shippingFor(cart.subtotalCents);
  const totalCents = cart.subtotalCents + shippingCents;

  // No database, so no order can be recorded. The cart page renders a mailto
  // link rather than a submit button in this mode, so getting here means a
  // stale page or a hand-made POST. Send them back rather than throwing a 500
  // — or worse, charging a card with nothing to reconcile it against.
  if (mode === "enquiry") {
    redirect("/cart?error=enquiry");
  }

  const orderId = newOrderId();

  if (mode === "demo") {
    await createOrder({
      id: orderId,
      mode: "demo",
      items,
      totalCents,
      shippingCents,
      currency: CURRENCY,
      status: "pending",
    });
    await markOrderPaid(orderId, null);
    await clearCart();
    redirect(`/order/success?order=${orderId}`);
  }

  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: cart.items.map((i) => ({
      quantity: i.qty,
      price_data: {
        currency: CURRENCY,
        unit_amount: i.unitPriceCents,
        product_data: {
          name: i.name,
          metadata: { sku: i.sku },
        },
      },
    })),
    shipping_address_collection: {
      allowed_countries:
        SHIPPING.countries as unknown as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
    },
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: shippingCents, currency: CURRENCY },
          display_name: shippingCents === 0 ? "Free shipping" : "Shipping",
        },
      },
    ],
    // The items are held for this shopper until the session expires (see
    // soldCounts in src/lib/db.ts). One spare minute keeps us clear of
    // Stripe's 30-minute minimum.
    expires_at:
      Math.floor(Date.now() / 1000) + (RESERVATION_MINUTES + 1) * 60,
    success_url: `${siteUrl()}/order/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl()}/cart?error=cancelled`,
    metadata: { orderId },
    client_reference_id: orderId,
  });

  await createOrder({
    id: orderId,
    mode: "stripe",
    items,
    totalCents,
    shippingCents,
    currency: CURRENCY,
    stripeSessionId: session.id,
    status: "pending",
  });

  const store = await cookies();
  store.set(CHECKOUT_COOKIE, orderId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
    secure: process.env.NODE_ENV === "production",
  });

  if (!session.url) {
    redirect("/cart?error=stripe");
  }
  redirect(session.url);
}
