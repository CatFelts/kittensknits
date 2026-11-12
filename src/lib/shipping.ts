/**
 * SHIPPING. Edit these three values to change what customers pay for postage.
 * Amounts are in CENTS, like prices in products.ts. 600 = $6.00.
 */
export const SHIPPING = {
  /** Charged once per order, however many items are in it. */
  flatCents: 600,
  /** Orders whose items add up to this or more ship free. null = never free. */
  freeOverCents: 10000 as number | null,
  /** Two-letter country codes Stripe will accept a delivery address for. */
  countries: ["US"] as const,
};

/** Postage for a cart with this subtotal. */
export function shippingFor(subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  const { flatCents, freeOverCents } = SHIPPING;
  if (freeOverCents !== null && subtotalCents >= freeOverCents) return 0;
  return flatCents;
}
