"use client";

import { useEffect, useState } from "react";

const COUNTED_KEY = "kk_counted";
const DIGITS = 6;

/**
 * A real hit counter, 1999-style. Counts each browser session once (a fresh
 * tab or a return visit counts; refreshing or clicking around does not).
 */
export function VisitorCounter() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alreadyCounted = false;
    try {
      alreadyCounted = sessionStorage.getItem(COUNTED_KEY) === "1";
    } catch {
      // Storage blocked (some private modes). Count, but don't remember it.
    }

    fetch("/api/visit", { method: alreadyCounted ? "GET" : "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { count: number | null } | null) => {
        if (typeof data?.count !== "number") return;
        setCount(data.count);
        try {
          sessionStorage.setItem(COUNTED_KEY, "1");
        } catch {
          // See above.
        }
      })
      .catch(() => {
        // Leave the dashes; it's an ornament.
      });
  }, []);

  const shown =
    count === null
      ? "-".repeat(DIGITS)
      : String(count).padStart(DIGITS, "0");

  return (
    <span
      className="bg-ink px-1 font-mono text-lime"
      aria-label={count === null ? "visitor count loading" : `visitor number ${count}`}
    >
      {shown}
    </span>
  );
}
