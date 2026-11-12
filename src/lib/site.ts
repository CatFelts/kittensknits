import { formatCents } from "@/lib/money";
import { SHIPPING } from "@/lib/shipping";

function shippingSummary(): string {
  const flat = `${formatCents(SHIPPING.flatCents)} flat shipping`;
  return SHIPPING.freeOverCents === null
    ? flat
    : `${flat}, free over ${formatCents(SHIPPING.freeOverCents).replace(".00", "")}`;
}

/** Shop-wide copy. Edit here rather than hunting through components. */
export const site = {
  name: "KittensKnits",
  tagline: "handspun yarn ⋆ knits ⋆ made one at a time",
  /**
   * This is the buy button. With no database in production the cart hands the
   * customer a pre-filled email to this address, so if it's wrong, orders go
   * nowhere. Swap in a kittensknits-specific address when you have one — it's
   * this one line and nothing else.
   */
  email: "catfelts@gmail.com",
  instagram: "@kittensknits",
  // Rates come from src/lib/shipping.ts, so this sentence can never disagree
  // with what checkout actually charges.
  shippingNote: `Ships within 3 business days from my home studio. US only. ${shippingSummary()}.`,
};
