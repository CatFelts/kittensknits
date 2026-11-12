import "server-only";

import { neon } from "@neondatabase/serverless";

/**
 * Postgres (Neon) holds the things that CHANGE: orders, and how many of each
 * item have sold. The catalog itself lives in src/lib/products.ts, not here.
 *
 * This is the ONLY file that knows about storage. It used to be SQLite on a
 * local disk; it is now Neon because the live site runs on Netlify, whose
 * filesystem is read-only and wiped on every deploy. If you ever move again,
 * this file is still the only one to rewrite.
 *
 * The driver talks to Neon over HTTP rather than a TCP pool. That matters on a
 * serverless host: every request may be a cold start, and there is no process
 * sitting around to own a connection pool. One query is one HTTP round trip.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim();

/**
 * THE DATABASE IS STILL OPTIONAL.
 *
 * With no DATABASE_URL the shop degrades to catalog-only: reads return "nothing
 * sold yet", so the storefront serves whatever `stock` says in products.ts, and
 * checkout-mode.ts routes the buy button to an email enquiry instead. That is
 * what a fresh `git clone && npm run dev` gets you, with no signup required.
 *
 * Unlike the old SQLite version this is a pure env-var check, not a probe. It
 * stays synchronous, which is why checkoutMode() can stay synchronous too.
 */
export function isDbAvailable(): boolean {
  return Boolean(DATABASE_URL);
}

type Sql = ReturnType<typeof neon>;

// Next.js reloads modules on every edit in dev. Cache the client on globalThis
// so a hot reload doesn't build a new one per request.
const globalForDb = globalThis as unknown as { __kkSql?: Sql };

/** For writers, which cannot meaningfully continue without a database. */
function db(): Sql {
  if (!DATABASE_URL) {
    throw new Error(
      "No DATABASE_URL, so orders cannot be recorded on this host. " +
        "See src/lib/checkout-mode.ts.",
    );
  }
  globalForDb.__kkSql ??= neon(DATABASE_URL);
  return globalForDb.__kkSql;
}

/** For readers, which must keep working with no database. */
function optionalDb(): Sql | null {
  return DATABASE_URL ? db() : null;
}

// The schema itself lives in src/lib/schema.ts and is applied by
// `npm run db:init`, which runs outside Next.js.

// --- inventory ---------------------------------------------------------------

/**
 * How long a shopper who has started Stripe checkout gets to pay before the
 * items go back on sale. Stripe's minimum session lifetime is 30 minutes.
 */
export const RESERVATION_MINUTES = 30;

/**
 * sku -> units unavailable: sold, plus units HELD by someone mid-checkout.
 * Missing rows mean zero.
 *
 * Holding matters because nearly everything here is one of a kind. Without it,
 * two shoppers could both reach Stripe with the same skein and both pay for it.
 * A hold is:
 *   - a 'pending' Stripe order younger than the session lifetime (plus a
 *     couple of minutes' grace), or
 *   - a 'processing' order: checkout finished but a slow payment method such
 *     as a bank transfer hasn't cleared yet.
 *
 * `excludeOrderId` leaves out the current shopper's own hold, so pressing Back
 * on the Stripe page doesn't make their own cart look sold out to them.
 *
 * With no database this returns an empty map, so the shop falls back to the
 * `stock` numbers in products.ts.
 */
export async function soldCounts(
  excludeOrderId: string | null = null,
): Promise<Map<string, number>> {
  const sql = optionalDb();
  if (!sql) return new Map();

  const rows = (await sql`
    SELECT sku, SUM(n)::int AS sold FROM (
      SELECT sku, sold AS n FROM inventory
      UNION ALL
      SELECT item->>'sku' AS sku, (item->>'qty')::int AS n
        FROM orders, LATERAL jsonb_array_elements(orders.items_json) AS item
       WHERE (orders.status = 'processing'
              OR (orders.status = 'pending'
                  AND orders.mode = 'stripe'
                  AND orders.created_at >
                      now() - make_interval(mins => ${RESERVATION_MINUTES + 2})))
         AND orders.id IS DISTINCT FROM ${excludeOrderId}::text
    ) unavailable
    GROUP BY sku
  `) as { sku: string; sold: number }[];
  return new Map(rows.map((r) => [r.sku, Number(r.sold)]));
}

// --- counters ----------------------------------------------------------------

/**
 * Add one to a named counter and return the new value. Returns null with no
 * database, so callers can hide the number instead of showing a fake one.
 */
export async function bumpCounter(name: string): Promise<number | null> {
  const sql = optionalDb();
  if (!sql) return null;

  const rows = (await sql`
    INSERT INTO counters (name, value) VALUES (${name}, 1)
    ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
    RETURNING value
  `) as { value: number | string }[];
  return Number(rows[0].value);
}

export async function readCounter(name: string): Promise<number | null> {
  const sql = optionalDb();
  if (!sql) return null;

  const rows = (await sql`
    SELECT value FROM counters WHERE name = ${name}
  `) as { value: number | string }[];
  return rows.length > 0 ? Number(rows[0].value) : 0;
}

// --- orders ------------------------------------------------------------------

export type OrderItem = {
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
};

/** Where to post it. Copied from Stripe once the customer has paid. */
export type ShippingAddress = {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
};

type OrderRow = {
  id: string;
  status: string;
  mode: string;
  email: string | null;
  total_cents: number;
  shipping_cents: number | null;
  shipping_json: ShippingAddress | string | null;
  currency: string;
  // jsonb comes back already parsed; tolerate a string in case the column is
  // ever migrated back to text.
  items_json: OrderItem[] | string;
  stripe_session_id: string | null;
  created_at: Date | string;
  paid_at: Date | string | null;
};

export type Order = {
  id: string;
  /**
   * pending     sent to Stripe, not paid yet (items held for a while)
   * processing  checkout done, slow payment (e.g. bank transfer) still clearing
   * paid        money received; stock decremented
   * cancelled   abandoned, expired, or the payment failed
   */
  status: "pending" | "processing" | "paid" | "cancelled";
  mode: "stripe" | "demo";
  email: string | null;
  /** Everything the customer paid, shipping included. */
  total_cents: number;
  shipping_cents: number;
  shipping: ShippingAddress | null;
  currency: string;
  stripe_session_id: string | null;
  created_at: string;
  paid_at: string | null;
  items: OrderItem[];
};

/**
 * Postgres hands back a Date for timestamptz. Render it the way the old SQLite
 * `datetime('now')` did — "2026-09-14 12:34:56", UTC — so the admin table reads
 * the same as it always has.
 */
function stamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function hydrate(row: OrderRow | undefined): Order | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as Order["status"],
    mode: row.mode as Order["mode"],
    email: row.email,
    total_cents: Number(row.total_cents),
    shipping_cents: Number(row.shipping_cents ?? 0),
    shipping:
      typeof row.shipping_json === "string"
        ? (JSON.parse(row.shipping_json) as ShippingAddress)
        : row.shipping_json,
    currency: row.currency,
    stripe_session_id: row.stripe_session_id,
    created_at: stamp(row.created_at)!,
    paid_at: stamp(row.paid_at),
    items:
      typeof row.items_json === "string"
        ? (JSON.parse(row.items_json) as OrderItem[])
        : row.items_json,
  };
}

export async function createOrder(input: {
  id: string;
  mode: "stripe" | "demo";
  items: OrderItem[];
  /** Shipping included. */
  totalCents: number;
  shippingCents: number;
  currency: string;
  stripeSessionId?: string | null;
  status?: "pending" | "paid";
  email?: string | null;
}): Promise<void> {
  const status = input.status ?? "pending";
  await db()`
    INSERT INTO orders
      (id, status, mode, email, total_cents, shipping_cents, currency, items_json, stripe_session_id, paid_at)
    VALUES
      (${input.id}, ${status}, ${input.mode}, ${input.email ?? null},
       ${input.totalCents}, ${input.shippingCents}, ${input.currency},
       ${JSON.stringify(input.items)}::jsonb, ${input.stripeSessionId ?? null},
       CASE WHEN ${status} = 'paid' THEN now() ELSE NULL END)
  `;
}

export async function getOrder(id: string): Promise<Order | null> {
  const sql = optionalDb();
  if (!sql) return null;

  const rows = (await sql`SELECT * FROM orders WHERE id = ${id}`) as OrderRow[];
  return hydrate(rows[0]);
}

export async function getOrderBySessionId(
  sessionId: string,
): Promise<Order | null> {
  const sql = optionalDb();
  if (!sql) return null;

  const rows = (await sql`
    SELECT * FROM orders WHERE stripe_session_id = ${sessionId}
  `) as OrderRow[];
  return hydrate(rows[0]);
}

/**
 * Mark an order paid and decrement inventory.
 *
 * Idempotent: Stripe retries webhooks, and the post-payment redirect races the
 * webhook, so this can genuinely be called twice at once for the same order. A
 * retry must not sell the same skein twice. Returns true if this call is the
 * one that applied the change.
 *
 * It is a SINGLE statement on purpose. The HTTP driver has no interactive
 * transactions — it cannot hold one open across a read, a decision, and a
 * write — so the read-then-write is expressed as one chain of CTEs, which
 * Postgres runs atomically:
 *
 *   claimed  flips the row to 'paid' ONLY IF it is not already paid, and
 *            returns what it bought. `WHERE status <> 'paid'` is what makes
 *            this safe: the loser of a concurrent double-fire updates no rows,
 *            gets no items back, and therefore bumps no stock.
 *   items    explodes that order's line items into rows.
 *   bumped   adds them to the sold counts.
 *
 * Because `bumped` reads from `claimed`, stock can only ever move for the call
 * that actually won the flip. No partial application, no double decrement.
 */
export async function markOrderPaid(
  orderId: string,
  email?: string | null,
  shipping?: ShippingAddress | null,
): Promise<boolean> {
  const rows = (await db()`
    WITH claimed AS (
      UPDATE orders
         SET status  = 'paid',
             paid_at = now(),
             email   = COALESCE(${email ?? null}, email),
             shipping_json = COALESCE(${shipping ? JSON.stringify(shipping) : null}::jsonb, shipping_json)
       WHERE id = ${orderId}
         AND status <> 'paid'
      RETURNING id, items_json
    ),
    items AS (
      SELECT item->>'sku' AS sku, (item->>'qty')::int AS qty
        FROM claimed,
             LATERAL jsonb_array_elements(claimed.items_json) AS item
    ),
    bumped AS (
      INSERT INTO inventory (sku, sold)
      SELECT sku, SUM(qty)::int FROM items GROUP BY sku
      ON CONFLICT (sku) DO UPDATE SET sold = inventory.sold + EXCLUDED.sold
      RETURNING sku
    )
    SELECT count(*)::int AS applied FROM claimed
  `) as { applied: number }[];

  return (rows[0]?.applied ?? 0) > 0;
}

/**
 * Checkout finished but the money hasn't cleared (a bank transfer, say). Keep
 * holding the items until Stripe tells us it succeeded or failed.
 */
export async function markOrderProcessing(
  orderId: string,
  email?: string | null,
  shipping?: ShippingAddress | null,
): Promise<void> {
  await db()`
    UPDATE orders
       SET status = 'processing',
           email  = COALESCE(${email ?? null}, email),
           shipping_json = COALESCE(${shipping ? JSON.stringify(shipping) : null}::jsonb, shipping_json)
     WHERE id = ${orderId} AND status = 'pending'
  `;
}

/**
 * Release an unpaid order's hold on its items. Never touches a paid order, so a
 * late or repeated "expired" event can't undo a sale.
 */
export async function cancelOrder(orderId: string): Promise<void> {
  await db()`
    UPDATE orders SET status = 'cancelled'
     WHERE id = ${orderId} AND status IN ('pending', 'processing')
  `;
}

export async function listOrders(limit = 100): Promise<Order[]> {
  const sql = optionalDb();
  if (!sql) return [];

  const rows = (await sql`
    SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT ${limit}
  `) as OrderRow[];
  return rows.map((r) => hydrate(r)!);
}
