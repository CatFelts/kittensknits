import "server-only";

import Stripe from "stripe";

import type { ShippingAddress } from "@/lib/db";

/**
 * Stripe is OPTIONAL. With no STRIPE_SECRET_KEY the shop falls back to a demo
 * checkout that records the order and decrements stock without taking money,
 * so you can click the whole flow before you ever open a Stripe account.
 */

const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

export const isStripeConfigured = Boolean(
  secretKey && secretKey.startsWith("sk_"),
);

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!isStripeConfigured) {
    throw new Error(
      "Stripe is not configured. Set STRIPE_SECRET_KEY in .env.local.",
    );
  }
  client ??= new Stripe(secretKey!);
  return client;
}

export function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    "http://localhost:3000"
  );
}

/**
 * The email and delivery address a customer typed into Stripe Checkout, in the
 * shape the orders table stores. Newer Stripe API versions moved the address
 * under `collected_information`, so look in both places.
 */
export function customerDetails(session: Stripe.Checkout.Session): {
  email: string | null;
  shipping: ShippingAddress | null;
} {
  const ship =
    session.collected_information?.shipping_details ??
    session.shipping_details ??
    null;
  const a = ship?.address;

  return {
    email: session.customer_details?.email ?? null,
    shipping: ship
      ? {
          name: ship.name ?? null,
          line1: a?.line1 ?? null,
          line2: a?.line2 ?? null,
          city: a?.city ?? null,
          state: a?.state ?? null,
          postal_code: a?.postal_code ?? null,
          country: a?.country ?? null,
        }
      : null,
  };
}
