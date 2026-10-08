// Perbandingan kunci jawaban (faktor S/W/O/T acuan kasus sintetis) dengan faktor hasil agen
// (output faktor_internal + faktor_eksternal: `factors[]`, lihat FaktorComputed di lib/nodes/contracts.ts). Modul murni.

export type Quadrant = "S" | "W" | "O" | "T";
export type GoldFactor = { id: string; quadrant: Quadrant; text: string };
export type AgentFactor = { id: string; quadrant: Quadrant; text: string; source: "faktor_internal" | "faktor_eksternal" };

const STOP = new Set(
  "yang dan di ke dari untuk dengan pada ini itu ada tidak belum sudah oleh sebagai dalam karena atau juga lebih masih akan para setiap serta bagi tersebut dapat telah antara secara hal agar kurang banyak sangat".split(
    " ",
  ),
);

/** Kata bermakna (huruf kecil, ≥ 3 huruf, tanpa kata sambung), dipangkas 6 huruf sebagai stem kasar. */
export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.slice(0, 6)),
  );
}

/** Kemiripan = |irisan| / min(|A|, |B|) (koefisien tumpang tindih); 0–1. */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/** Faktor agen dari output analisis faktor (bentuk FaktorComputed; aman terhadap output yang belum lengkap). */
export function agentFactors(outputs: { faktor_internal?: unknown; faktor_eksternal?: unknown }): AgentFactor[] {
  const out: AgentFactor[] = [];
  for (const source of ["faktor_internal", "faktor_eksternal"] as const) {
    const fs = (outputs[source] as { factors?: unknown } | undefined)?.factors;
    if (!Array.isArray(fs)) continue;
    for (const f of fs) {
      const x = f as { id?: unknown; quadrant?: unknown; text?: unknown };
      if (typeof x?.id !== "string" || typeof x.text !== "string") continue;
      const q = typeof x.quadrant === "string" && /^[SWOT]$/.test(x.quadrant) ? (x.quadrant as Quadrant) : (x.id[0] as Quadrant);
      if (!/^[SWOT]$/.test(q)) continue;
      out.push({ id: x.id, quadrant: q, text: x.text, source });
    }
  }
  return out;
}

export type GoldMatch = {
  gold: GoldFactor;
  /** Faktor agen paling mirip di kuadran yang sama (null bila tidak ada yang cukup mirip). */
  match: AgentFactor | null;
  score: number;
  /** Faktor agen yang mirip tetapi di kuadran lain (kemungkinan kuadran tertukar). */
  otherQuadrant: AgentFactor | null;
};

/**
 * Cocokkan setiap faktor kunci jawaban dengan faktor agen yang paling mirip (ambang `threshold`).
 * recall = kunci yang ditemukan agen ÷ semua kunci; precision = faktor agen yang cocok dengan kunci ÷ semua faktor agen.
 */
export function compareGold(gold: GoldFactor[], agent: AgentFactor[], threshold = 0.4) {
  const used = new Set<string>();
  const matches: GoldMatch[] = gold.map((g) => {
    let best: AgentFactor | null = null;
    let score = 0;
    let other: AgentFactor | null = null;
    let otherScore = 0;
    for (const a of agent) {
      const s = similarity(g.text, a.text);
      if (a.quadrant === g.quadrant) {
        if (s > score) {
          best = a;
          score = s;
        }
      } else if (s > otherScore) {
        other = a;
        otherScore = s;
      }
    }
    const ok = best && score >= threshold ? best : null;
    if (ok) used.add(ok.id);
    return { gold: g, match: ok, score, otherQuadrant: !ok && other && otherScore >= threshold ? other : null };
  });
  const found = matches.filter((m) => m.match).length;
  return {
    matches,
    recall: gold.length ? found / gold.length : NaN,
    precision: agent.length ? used.size / agent.length : NaN,
    unmatchedAgent: agent.filter((a) => !used.has(a.id)),
  };
}
