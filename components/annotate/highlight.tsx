"use client";
import type { ReactNode } from "react";
import { norm } from "@/lib/validators/common";

const QUOTE_CHARS: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"', "–": "-", "—": "-" };

/**
 * Cari kutipan di teks tanpa peduli huruf besar-kecil, spasi, dan jenis tanda kutip (sama dengan norm() validator).
 * Mengembalikan rentang [start, end) pada teks asli, atau null.
 */
export function findQuote(content: string, quote: string): [number, number] | null {
  const q = norm(quote);
  if (!q) return null;
  let s = "";
  const map: number[] = [];
  let prevSpace = true; // buang spasi di awal (norm() melakukan trim)
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      s += " ";
      map.push(i);
      prevSpace = true;
      continue;
    }
    prevSpace = false;
    s += (QUOTE_CHARS[ch] ?? ch).toLowerCase();
    // toLowerCase bisa mengubah panjang (jarang); petakan semua karakter hasil ke indeks asli
    while (map.length < s.length) map.push(i);
  }
  const at = s.indexOf(q);
  if (at < 0) return null;
  return [map[at], map[at + q.length - 1] + 1];
}

/** Teks potongan dengan kutipan disorot <mark>. */
export function Highlighted({ content, quotes }: { content: string; quotes: string[] }) {
  const ranges = quotes
    .map((q) => findQuote(content, q))
    .filter((r): r is [number, number] => !!r)
    .sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([a, b], i) => {
    if (a < pos) a = pos; // rentang tumpang tindih
    if (b <= a) return;
    if (a > pos) parts.push(content.slice(pos, a));
    parts.push(<mark key={i}>{content.slice(a, b)}</mark>);
    pos = b;
  });
  parts.push(content.slice(pos));
  return <>{parts}</>;
}
