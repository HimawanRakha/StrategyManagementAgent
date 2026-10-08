// AHP bersama untuk node yang punya bobot (stakeholder, faktor S+W/O+T, penilaian staf, …). Modul murni (aman di client).
// AI mengusulkan perbandingan berpasangan (skala Saaty), kode menghitung bobot dan rasio konsistensi, pengguna bisa mengubah
// setiap perbandingan di sheet AHP (lihat lib/sheets/ahp-sheet.ts).
import { z } from "zod";
import { ahp, allPairs, snapSaaty, worstPairs, saatyText } from "@/lib/calc/ahp";
import { result } from "@/lib/validators/common";
import type { AhpSetComputed, AhpSetRaw } from "./contracts";
import type { CheckResult, Failure } from "./types";

export const AhpPairSchema = z.object({
  a: z.string(),
  b: z.string(),
  /** a_ab pada skala Saaty: 1–9 bila a lebih penting, 1/2–1/9 (desimal, mis. 0.333) bila b lebih penting. */
  v: z.number().positive(),
});

export const AhpSetSchema = z.object({
  id: z.string(),
  items: z.array(z.string()),
  pairs: z.array(AhpPairSchema).default([]),
});

/** Hitung satu himpunan AHP dari output mentah. */
export function computeAhpSet(raw: AhpSetRaw, label: string): AhpSetComputed {
  const r = ahp(raw.items, raw.pairs ?? []);
  return {
    id: raw.id,
    label,
    items: raw.items,
    weights: r.weights,
    lambdaMax: r.lambdaMax,
    ci: r.ci,
    ri: r.ri,
    cr: r.cr,
    consistent: r.consistent,
    missing: r.missing,
  };
}

/** Bobot per ID dari himpunan yang sudah dihitung. */
export const weightsOf = (s: AhpSetComputed | undefined): Record<string, number> =>
  s ? Object.fromEntries(s.items.map((id, i) => [id, s.weights[i] ?? 0])) : {};

/** Aturan AHP untuk prompt (tempel di system prompt node). */
export const AHP_RULES = `BOBOT DIHITUNG DENGAN AHP (Analytic Hierarchy Process). Kamu TIDAK menulis bobot; kamu mengisi perbandingan berpasangan:
- Untuk SETIAP pasangan butir (a, b) dalam satu himpunan, isi v = seberapa penting a dibanding b menurut skala Saaty:
  1 = sama penting, 3 = a sedikit lebih penting, 5 = a jelas lebih penting, 7 = a sangat jelas lebih penting, 9 = a mutlak lebih penting
  (2, 4, 6, 8 = nilai antara). Bila b yang lebih penting, tulis kebalikannya sebagai desimal: 1/3 = 0.333, 1/5 = 0.2, 1/7 = 0.143, 1/9 = 0.111.
- Tulis setiap pasangan TEPAT SEKALI (a sebelum b sesuai urutan "items"), jangan ada pasangan yang terlewat.
- Jaga konsistensi: bila a > b dan b > c, maka a > c dengan nilai yang lebih besar. Rasio konsistensi (CR) harus ≤ 0,10.
- Dasarkan penilaian pada bukti dokumen (seberapa besar pengaruh/urgensi butir bagi organisasi).`;

/** Daftar pasangan yang wajib diisi untuk prompt: "S1 vs S2; S1 vs S3; …". */
export const pairList = (items: string[]) =>
  allPairs(items)
    .map(([a, b]) => `${a} vs ${b}`)
    .join("; ");

/**
 * Mock deterministik: perbandingan dari skor kepentingan (rasio skor dibulatkan ke skala Saaty) → hampir konsisten.
 * `importance(id)` > 0.
 */
export function mockAhpSet(id: string, items: string[], importance: (id: string) => number): AhpSetRaw {
  return {
    id,
    items,
    pairs: allPairs(items).map(([a, b]) => ({ a, b, v: snapSaaty(Math.max(0.01, importance(a)) / Math.max(0.01, importance(b))) })),
  };
}

/** Cek kode: setiap pasangan terisi dan tidak merujuk butir asing. */
export function checkAhpComplete(raws: AhpSetRaw[], labelOf: (setId: string) => string = (s) => s): CheckResult {
  const failures: Failure[] = [];
  for (const s of raws) {
    const ids = new Set(s.items);
    const bad = (s.pairs ?? []).filter((p) => !ids.has(p.a) || !ids.has(p.b) || p.a === p.b);
    if (bad.length)
      failures.push({ check: "ahp_complete", itemId: s.id, message: `AHP ${labelOf(s.id)}: perbandingan merujuk butir yang tidak ada (${bad.map((p) => `${p.a}–${p.b}`).join(", ")}).` });
    const have = new Set((s.pairs ?? []).map((p) => [p.a, p.b].sort().join("|")));
    const missing = allPairs(s.items).filter(([a, b]) => !have.has([a, b].sort().join("|")));
    if (missing.length)
      failures.push({
        check: "ahp_complete",
        itemId: s.id,
        message: `AHP ${labelOf(s.id)}: ${missing.length} perbandingan belum diisi (${missing.slice(0, 6).map(([a, b]) => `${a} vs ${b}`).join(", ")}${missing.length > 6 ? ", …" : ""}).`,
      });
  }
  return result("ahp_complete", "code", failures);
}

/** Cek kode: rasio konsistensi CR ≤ 0,10 di setiap himpunan (dengan saran pasangan yang paling tidak konsisten). */
export function checkAhpConsistency(raws: AhpSetRaw[], labelOf: (setId: string) => string = (s) => s): CheckResult {
  const failures: Failure[] = [];
  for (const s of raws) {
    if (s.items.length < 3) continue;
    const r = ahp(s.items, s.pairs ?? []);
    if (r.consistent) continue;
    const worst = worstPairs(r, 3)
      .map((w) => `${w.a} vs ${w.b} (diisi ${saatyText(w.given)}, yang konsisten ≈ ${saatyText(snapSaaty(w.implied))})`)
      .join("; ");
    failures.push({
      check: "ahp_consistency",
      itemId: s.id,
      message: `AHP ${labelOf(s.id)} tidak konsisten: CR = ${r.cr.toFixed(3).replace(".", ",")} > 0,10. Tinjau ulang: ${worst}.`,
    });
  }
  return result("ahp_consistency", "code", failures);
}

export const AHP_CHECKS = [
  { name: "ahp_complete", kind: "code" as const, description: "Ada perbandingan AHP yang belum diisi atau merujuk butir yang tidak ada" },
  { name: "ahp_consistency", kind: "code" as const, description: "Rasio konsistensi AHP (CR) lebih dari 0,10 — penilaian berpasangan saling bertentangan" },
];
