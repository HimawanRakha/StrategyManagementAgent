// Alat bersama node Strategy Generation & Selection (posisi, matriks SWOT, QSPM, cascading). Modul murni (aman di client).
import type {
  CascadingComputed,
  FaktorComputed,
  PosisiComputed,
  QspmComputedV2,
  Quadrant,
  Strategy,
  StrategyType,
  SwotMatrixComputed,
} from "../contracts";

export type Inputs = Partial<Record<string, unknown>>;

/** Nomor di ujung ID: "S12" → 12, "SO3" → 3. */
export const idNum = (id: string) => {
  const m = /(\d+)\s*$/.exec(id);
  return m ? Number(m[1]) : 0;
};

export const QUADRANTS: Quadrant[] = ["S", "W", "O", "T"];
export const QUADRANT_LABEL: Record<Quadrant, string> = { S: "Strength", W: "Weakness", O: "Opportunity", T: "Threat" };

/** Kuadran faktor dari ID bila field quadrant tidak ada. */
export function quadrantOf(id: string): Quadrant | null {
  const c = id.trim().charAt(0).toUpperCase();
  return (QUADRANTS as string[]).includes(c) ? (c as Quadrant) : null;
}

export type FactorLite = { id: string; quadrant: Quadrant; text: string; bobot: number; category: string };

/** Semua faktor S, W (Faktor S+W) dan O, T (Faktor O+T) berurutan S → W → O → T lalu nomor. */
export function factorsOf(inputs: Inputs): FactorLite[] {
  const fi = inputs.faktor_internal as FaktorComputed | undefined;
  const fe = inputs.faktor_eksternal as FaktorComputed | undefined;
  const seen = new Set<string>();
  const out: FactorLite[] = [];
  for (const f of [...(fi?.factors ?? []), ...(fe?.factors ?? [])]) {
    if (!f || typeof f.id !== "string" || seen.has(f.id)) continue;
    const q = (QUADRANTS as string[]).includes(f.quadrant) ? f.quadrant : quadrantOf(f.id);
    if (!q) continue;
    seen.add(f.id);
    out.push({
      id: f.id,
      quadrant: q,
      text: String(f.text ?? ""),
      bobot: Number.isFinite(f.bobot) ? f.bobot : 0,
      category: String(f.category ?? ""),
    });
  }
  return out.sort((a, b) => QUADRANTS.indexOf(a.quadrant) - QUADRANTS.indexOf(b.quadrant) || idNum(a.id) - idNum(b.id));
}

/** Urutan tipe di matriks SWOT (baris O: SO, WO; baris T: ST, WT). */
export const STRATEGY_TYPES: StrategyType[] = ["SO", "WO", "ST", "WT"];
/** Urutan kolom QSPM di Excel: semua SO, lalu ST, WO, WT. */
export const QSPM_ORDER: StrategyType[] = ["SO", "ST", "WO", "WT"];

export const TYPE_INFO: Record<StrategyType, { internal: "S" | "W"; external: "O" | "T"; label: string; criteria: string; arti: string }> = {
  SO: {
    internal: "S",
    external: "O",
    label: "Strength–Opportunity",
    criteria: "SO Strategies use a firm internal strengths to take advantage of external opportunities",
    arti: "Gunakan kekuatan internal untuk meraih peluang eksternal.",
  },
  WO: {
    internal: "W",
    external: "O",
    label: "Weakness–Opportunity",
    criteria: "WO Strategies aim at improving internal weaknesses by taking advantage of external opportunities",
    arti: "Perbaiki kelemahan internal dengan memanfaatkan peluang eksternal.",
  },
  ST: {
    internal: "S",
    external: "T",
    label: "Strength–Threat",
    criteria: "ST Strategies use a firm strengths to avoid or reduce the impact of external threats",
    arti: "Gunakan kekuatan untuk menghindari atau mengurangi dampak ancaman eksternal.",
  },
  WT: {
    internal: "W",
    external: "T",
    label: "Weakness–Threat",
    criteria: "WT Strategies are defensive tactics directed at reducing internal weakness and avoiding external threats",
    arti: "Taktik bertahan: kurangi kelemahan internal dan hindari ancaman eksternal.",
  },
};

export const isStrategyType = (s: unknown): s is StrategyType => typeof s === "string" && (STRATEGY_TYPES as string[]).includes(s);

/** Tipe strategi dari ID ("ST2" → "ST"). */
export function typeOfId(id: string): StrategyType | null {
  const m = /^(SO|WO|ST|WT)/i.exec(id.trim());
  return m ? (m[1].toUpperCase() as StrategyType) : null;
}

/** Rapikan daftar kode faktor: huruf besar, tanpa duplikat. */
export const cleanRefs = (refs: unknown): string[] =>
  [...new Set((Array.isArray(refs) ? refs : []).map((r) => String(r).trim().toUpperCase()).filter(Boolean))];

/** Kode faktor berurutan S → W → O → T lalu nomor: ["O1","S2","S1"] → "S1 + S2 + O1". */
export function strategyCode(refs: string[]): string {
  const rank = (id: string) => {
    const q = quadrantOf(id);
    return q ? QUADRANTS.indexOf(q) : 9;
  };
  return [...refs].sort((a, b) => rank(a) - rank(b) || idNum(a) - idNum(b)).join(" + ");
}

export type StrategyLite = Strategy & { code: string };

/** Strategi dari matriks SWOT (setelah compute), dengan kode faktor. */
export function strategiesOf(inputs: Inputs): StrategyLite[] {
  const sm = inputs.swot_matrix as SwotMatrixComputed | undefined;
  return (sm?.strategies ?? [])
    .filter((s) => s && typeof s.id === "string")
    .map((s) => {
      const type = isStrategyType(s.type) ? s.type : (typeOfId(s.id) ?? "SO");
      const refs = cleanRefs(s.factorRefs);
      return { id: s.id, type, factorRefs: refs, text: String(s.text ?? ""), code: strategyCode(refs) };
    });
}

/** Urutkan strategi menurut urutan tipe lalu urutan aslinya. */
export function orderStrategies<T extends { type: StrategyType }>(xs: T[], order: StrategyType[]): T[] {
  return xs
    .map((x, i) => ({ x, i }))
    .sort((a, b) => order.indexOf(a.x.type) - order.indexOf(b.x.type) || a.i - b.i)
    .map((e) => e.x);
}

export type RankedStrategy = QspmComputedV2["ranking"][number];

/** Peringkat QSPM (urut peringkat), kosong bila QSPM belum ada. */
export function qspmRankingOf(inputs: Inputs): RankedStrategy[] {
  const q = inputs.qspm as QspmComputedV2 | undefined;
  return [...(q?.ranking ?? [])].filter((r) => r && typeof r.id === "string").sort((a, b) => a.rank - b.rank);
}

export const posisiOf = (inputs: Inputs) => inputs.posisi_organisasi as PosisiComputed | undefined;
export const cascadingOf = (inputs: Inputs) => inputs.cascading as CascadingComputed | undefined;

/** Huruf pertama dikecilkan kecuali singkatan; tanda baca penutup dibuang (untuk menyusun kalimat mock). */
export const lcFirst = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1)).replace(/[.…;,\s]+$/, "");

/** Potong teks panjang di batas kata. */
export function clip(s: string, n = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(n * 0.6))).replace(/[,;:\s]+$/, "") + "…";
}

/** Objek berbentuk output mentah (bukan hasil compute) — dipakai sheets/items agar tetap jalan saat menunggu tinjauan. */
export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
