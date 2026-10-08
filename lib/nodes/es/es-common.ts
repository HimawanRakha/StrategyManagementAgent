// Alat bersama node Environmental Scanning (stakeholder, faktor S+W/O+T, IFAS/EFAS). Modul murni (aman di client).
//
// "Tampilan" AHP (AhpView): himpunan perbandingan untuk sekumpulan butir yang diambil dari SEMUA himpunan mentah node
// (di himpunan mana pun AI menaruh pasangannya). Ini membuat hitungan tetap benar bila butir berpindah kelompok
// (mis. pengguna mengubah power/interest jabatan) dan setiap sel perbandingan tetap menunjuk path mentah yang benar.
import { allPairs, ahp, saatyText, snapSaaty, worstPairs } from "@/lib/calc/ahp";
import { result } from "@/lib/validators/common";
import type { AhpPair } from "@/lib/calc/ahp";
import type { AhpSetRaw } from "../contracts";
import type { CheckResult, Failure, LlmSession } from "../types";
import type { Grid } from "@/lib/sheets/grid";

export type Path = (string | number)[];

export type AhpView = {
  /** Himpunan untuk dihitung/ditampilkan (butir = `items`, pasangan = yang ada di output mentah, orientasi asli). */
  raw: AhpSetRaw;
  /** Path nilai `v` di output mentah untuk pasangan ke-k di `raw.pairs`. */
  paths: Path[];
};

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Ambil perbandingan antar-`items` dari semua himpunan mentah. Pasangan ganda: yang terakhir dipakai
 * (sama dengan `ahp()`); orientasi (a, b) dipertahankan agar nilai yang diedit tetap bermakna sama.
 */
export function ahpView(sets: AhpSetRaw[] | undefined, id: string, items: string[], basePath: Path = ["ahp"]): AhpView {
  const want = new Set(items);
  const found = new Map<string, { pair: AhpPair; path: Path }>();
  (sets ?? []).forEach((s, si) =>
    (s?.pairs ?? []).forEach((p, pi) => {
      if (!p || !want.has(p.a) || !want.has(p.b) || p.a === p.b) return;
      const k = pairKey(p.a, p.b);
      found.delete(k);
      found.set(k, { pair: { a: p.a, b: p.b, v: p.v }, path: [...basePath, si, "pairs", pi, "v"] });
    }),
  );
  const order = new Map(allPairs(items).map(([a, b], i) => [pairKey(a, b), i]));
  const entries = [...found.entries()].sort((x, y) => (order.get(x[0]) ?? 0) - (order.get(y[0]) ?? 0));
  return { raw: { id, items, pairs: entries.map((e) => e[1].pair) }, paths: entries.map((e) => e[1].path) };
}

/** Penanda path sementara untuk `ahpGrid`, diganti path mentah sesungguhnya oleh `remapAhpEdits`. */
export const VIEW_TAG = "__view";

/** Ganti path edit sementara [VIEW_TAG, i, "pairs", k, "v"] dengan path mentah dari `views[i].paths[k]`. */
export function remapAhpEdits(g: Grid, views: AhpView[]): Grid {
  g.cells = g.cells.map((c) => {
    const p = c.edit?.path;
    if (!p || p[0] !== VIEW_TAG) return c;
    const real = views[p[1] as number]?.paths[p[3] as number];
    if (real) return { ...c, edit: { ...c.edit!, path: real } };
    const rest = { ...c };
    delete rest.edit;
    return rest;
  });
  return g;
}

/** Pasangan yang hilang dari tampilan AHP. */
export function missingPairs(v: AhpSetRaw): [string, string][] {
  const have = new Set((v.pairs ?? []).map((p) => pairKey(p.a, p.b)));
  return allPairs(v.items).filter(([a, b]) => !have.has(pairKey(a, b)));
}

/**
 * Cek kode ahp_complete untuk tampilan AHP: SEMUA pasangan yang hilang disebutkan (agar perbaikan AI bisa tepat),
 * ditambah pasangan di output mentah yang merujuk butir yang tidak ada.
 */
export function checkAhpViews(views: AhpSetRaw[], rawSets: AhpSetRaw[], validIds: Set<string>, labelOf: (id: string) => string): CheckResult {
  const failures: Failure[] = [];
  for (const v of views) {
    const miss = missingPairs(v);
    if (miss.length)
      failures.push({
        check: "ahp_complete",
        itemId: v.id,
        message: `AHP ${labelOf(v.id)}: ${miss.length} perbandingan belum diisi (dianggap sama penting): ${miss
          .slice(0, 120)
          .map(([a, b]) => `${a} vs ${b}`)
          .join("; ")}${miss.length > 120 ? "; …" : ""}.`,
      });
  }
  for (const s of rawSets ?? []) {
    const bad = (s?.pairs ?? []).filter((p) => !validIds.has(p.a) || !validIds.has(p.b) || p.a === p.b);
    if (bad.length)
      failures.push({
        check: "ahp_complete",
        itemId: s.id,
        message: `AHP "${s.id}": perbandingan merujuk butir yang tidak ada (${bad
          .slice(0, 10)
          .map((p) => `${p.a}–${p.b}`)
          .join(", ")}${bad.length > 10 ? ", …" : ""}).`,
      });
  }
  return result("ahp_complete", "code", failures);
}

/** Cek kode ahp_consistency untuk tampilan AHP (CR ≤ 0,10), dengan saran pasangan yang paling bertentangan. */
export function checkAhpViewsConsistency(views: AhpSetRaw[], labelOf: (id: string) => string): CheckResult {
  const failures: Failure[] = [];
  for (const s of views) {
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

/** Gabungkan kegagalan dari beberapa CheckResult dengan nama cek yang sama. */
export function mergeChecks(name: string, kind: "code" | "llm", parts: CheckResult[]): CheckResult {
  return result(
    name,
    kind,
    parts.flatMap((p) => p.failures.map((f) => ({ ...f, check: name }))),
  );
}

/** Teks dinormalisasi untuk deteksi duplikat. */
export const normText = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Kemiripan kata (Jaccard) antar-dua teks — dipakai cek duplikat. */
export function similarity(a: string, b: string): number {
  const wa = new Set(normText(a).split(" ").filter((w) => w.length > 2));
  const wb = new Set(normText(b).split(" ").filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

/** Nomor dari ID ("S12" → 12). */
export const idNum = (id: string) => {
  const m = /(\d+)\s*$/.exec(id ?? "");
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/** LLM tiruan untuk uji: setiap panggilan memakai fungsi mock-nya. */
export const mockLlm: LlmSession = { json: async (_p, _s, _u, _schema, mock) => mock() };

/** Warna isi sel meniru Excel framework (hex tanpa #). */
export const FILL = {
  navy: "002060",
  blue: "0070C0",
  factor: "85CBFE",
  rating: "CFE2F3",
  calc: "C0E4FF",
  red: "EA4335",
  power: "990000",
  level: "CC0000",
  quadrant: "E06666",
  names: "EA9999",
  mapping: "660000",
  tableHead: "45818E",
  KP: "B6D7A8",
  KS: "A2C4C9",
  KI: "A4C2F4",
  M: "B4A7D6",
} as const;

/** Jumlah tanpa galat pembulatan berarti (urut seperti Excel). */
export const sum = (xs: number[]) => xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
