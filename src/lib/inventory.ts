import "server-only";

import { cookies } from "next/headers";

import { soldCounts } from "@/lib/db";
import { type Product, products } from "@/lib/products";

export type Stocked = Product & { available: number; soldOut: boolean };

/**
 * Cookie holding the id of the order this browser most recently sent to Stripe.
 * Its hold on stock is ignored for this shopper (see soldCounts in db.ts), and
 * checkout() uses it to release that hold before starting a new one.
 */
export const CHECKOUT_COOKIE = "kk_checkout";

export async function ownPendingOrderId(): Promise<string | null> {
  const store = await cookies();
  return store.get(CHECKOUT_COOKIE)?.value ?? null;
}

/** Join the static catalog against what the database says is sold or held. */
export async function withStock(
  list: Product[] = products,
): Promise<Stocked[]> {
  const sold = await soldCounts(await ownPendingOrderId());
  return list.map((p) => {
    const available = Math.max(0, p.stock - (sold.get(p.slug) ?? 0));
    return { ...p, available, soldOut: available === 0 };
  });
}

export async function stockFor(product: Product): Promise<Stocked> {
  return (await withStock([product]))[0];
}
