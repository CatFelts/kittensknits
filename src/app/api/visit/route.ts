import { NextResponse } from "next/server";

import { bumpCounter, readCounter } from "@/lib/db";

/**
 * The footer's visitor counter.
 *
 *   POST  counts a new visit and returns the new total
 *   GET   returns the total without counting
 *
 * The browser decides which to call (see components/VisitorCounter.tsx): it
 * POSTs once per browser tab session, so clicking around the shop or
 * refreshing doesn't inflate the number. It stores nothing about the visitor.
 *
 * `count` is null when the site has no database, and the footer then shows
 * dashes instead of a made-up number.
 */

export const dynamic = "force-dynamic";

const NAME = "visitors";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  return NextResponse.json({ count: await safely(() => readCounter(NAME)) }, { headers });
}

export async function POST() {
  return NextResponse.json({ count: await safely(() => bumpCounter(NAME)) }, { headers });
}

/** A decoration must never break the page, so a database hiccup is just null. */
async function safely(fn: () => Promise<number | null>): Promise<number | null> {
  try {
    return await fn();
  } catch (err) {
    console.error("[visit] counter unavailable:", err);
    return null;
  }
}
