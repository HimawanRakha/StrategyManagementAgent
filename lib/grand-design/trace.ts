// Graf rujukan ID antar-analisis untuk node per tab Excel. Modul murni (aman di client).
//
// Rantai yang ditelusuri (dari elemen hilir mundur ke bukti):
//   misi/aspek (cascading) → SO → SI → strategi (swot_matrix) → faktor (faktor_internal/eksternal) → kutipan dokumen
//   arah kerja (renstra) → milestone → (rujukan milestone, mis. misi/SO bila diisi node renstra)
//   butir analisis lain (kontinuitas, MSDM, DM-CRM, kustom) → apa pun yang dirujuk lewat field `refs`/`…Ref(s)`,
//   isi bertingkat (mis. keputusan → kondisi), atau bukti (`evidence`, refs berlabel C…/U…).
// Toleran terhadap output yang belum lengkap: bagian yang tidak dikenal dilewati, tidak pernah melempar galat.
import type { Evidence } from "@/lib/nodes/schemas";

export type TraceKind =
  | "factor"
  | "strategy"
  | "initiative"
  | "objective"
  | "mission"
  | "milestone"
  | "arah"
  | "proker"
  | "msdm"
  | "decision"
  | "change"
  | "risk"
  | "custom"
  | "element"
  // jenis lama (dipertahankan agar tampilan lama tetap jalan)
  | "issue"
  | "program";

export const TRACE_KIND_LABEL: Record<TraceKind, string> = {
  factor: "faktor",
  strategy: "strategi",
  initiative: "inisiatif strategis (SI)",
  objective: "sasaran strategis (SO)",
  mission: "misi",
  milestone: "milestone",
  arah: "arah kerja",
  proker: "program kerja",
  msdm: "MSDM",
  decision: "keputusan",
  change: "perubahan",
  risk: "risiko",
  custom: "analisis kustom",
  element: "butir",
  issue: "isu",
  program: "program",
};

export type TraceEl = {
  /** ID tampilan (mis. "S1", "SO2", "SI1.1"). */
  id: string;
  kind: TraceKind;
  text: string;
  /** Kunci indeks yang dirujuk (biasanya sama dengan ID; lihat `buildTraceIndex` untuk ID ganda). */
  refs: string[];
  evidence?: Evidence[];
  /** Analisis asal elemen. */
  nodeKey?: string;
};
export type TraceNode = TraceEl & { found: boolean; complete: boolean; children: TraceNode[] };
export type TraceChain = { id: string; kind: TraceKind; nodeKey?: string; text: string; path: string; complete: boolean };

/** Output (setelah kalkulator) per kunci analisis. Bentuk longgar: kunci yang tidak dikenal diabaikan. */
export type TraceOutputs = Partial<Record<string, unknown>>;

const CHUNK_ID = /^[CU]\d+$/;
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

const TEXT_KEYS = [
  "text", "name", "nama", "judul", "title", "keputusan", "kondisi", "risiko", "risk", "perubahan", "kegiatan",
  "program", "uraian", "deskripsi", "description", "aspek", "misi", "strategi", "tujuan", "label",
];
function textOf(o: Record<string, unknown>, id: string): string {
  for (const k of TEXT_KEYS) {
    const v = str(o[k]);
    if (v) return v;
  }
  return id;
}

/** Rujukan + petunjuk analisis tujuan (dari nama field) untuk memilih elemen yang benar bila ID dipakai beberapa analisis. */
type RefSpec = { ref: string; hint: readonly string[] | "key" | null };

/** Field rujukan: `refs`, `xxxRefs`, `xxxRef`, serta tautan DM-CRM (`menangani`, `dariKondisi`, `dariKeputusan`, …). */
const isRefKey = (k: string) => /^refs?$|[a-z0-9]Refs?$|^dari[A-Z]\w*$|^menangani$/.test(k);

const HINTS: [RegExp, readonly string[]][] = [
  [/^(factor|faktor)/i, ["faktor_internal", "faktor_eksternal"]],
  [/^strateg/i, ["swot_matrix"]],
  [/^(si|initiative|inisiatif)/i, ["cascading"]],
  [/^(so|objective|sasaran)/i, ["cascading"]],
  [/^(aspek|aspect)/i, ["cascading"]],
  [/^(misi|mission)/i, ["renstra", "cascading"]],
  [/^milestone/i, ["renstra"]],
  [/^arah/i, ["renstra"]],
  [/^(keputusan|decision|darikeputusan)/i, ["decision_making"]],
  [/^(kondisi|darikondisi|menangani|konsekuensi|darikonsekuensi)/i, ["decision_making"]],
  [/^(proker|program)/i, ["kontinuitas_proker"]],
  [/^(risk|risiko)/i, ["risk_management"]],
  [/^(change|tahap|step)/i, ["change_management"]],
];
const hintOf = (field: string) => HINTS.find(([re]) => re.test(field))?.[1] ?? null;

function declaredRefs(o: Record<string, unknown>): RefSpec[] {
  const out: RefSpec[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(o)) {
    if (!isRefKey(k)) continue;
    const hint = hintOf(k);
    const push = (r: unknown) => {
      if (typeof r !== "string" || !r.trim() || seen.has(r.trim())) return;
      seen.add(r.trim());
      out.push({ ref: r.trim(), hint });
    };
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
  }
  return out;
}
const keysOf = (keys: string[]): RefSpec[] => keys.map((ref) => ({ ref, hint: "key" as const }));

function evidenceOf(o: Record<string, unknown>): Evidence[] {
  return arr(o.evidence).filter((e): e is Evidence => !!obj(e) && typeof (e as Evidence).chunkId === "string");
}

/** Pembangun indeks: ID tampilan bisa dipakai beberapa analisis (mis. "A" aspek cascading dan milestone renstra). */
class Indexer {
  idx = new Map<string, TraceEl>();
  private specs = new Map<string, RefSpec[]>();
  /** Daftarkan elemen; `refs` diisi dari `specs` saat `finish()`. Mengembalikan kunci indeks. */
  add(el: Omit<TraceEl, "refs">, specs: RefSpec[] = []): string {
    let key = el.id;
    if (this.idx.has(key)) {
      const prev = this.idx.get(key)!;
      if (prev.nodeKey === el.nodeKey) return key; // ID ganda di analisis yang sama: pertahankan yang pertama
      key = `${el.id}@${el.nodeKey ?? "?"}`;
      let n = 2;
      while (this.idx.has(key)) key = `${el.id}@${el.nodeKey ?? "?"}#${n++}`;
    }
    const ev = [...(el.evidence ?? [])];
    // Rujukan berlabel C…/U… adalah bukti langsung.
    for (const s of specs) if (s.hint !== "key" && CHUNK_ID.test(s.ref)) ev.push({ chunkId: s.ref, quote: "" });
    const full: TraceEl = { ...el, refs: [] };
    if (ev.length) full.evidence = ev;
    else delete full.evidence;
    this.idx.set(key, full);
    this.specs.set(key, specs.filter((s) => s.hint === "key" || !CHUNK_ID.test(s.ref)));
    return key;
  }
  /** Selesaikan rujukan: kunci persis; lalu elemen ber-ID itu di analisis yang ditunjuk nama field; lalu kunci polos. */
  finish() {
    const byDisplay = new Map<string, string[]>();
    for (const [k, el] of this.idx) byDisplay.set(el.id, [...(byDisplay.get(el.id) ?? []), k]);
    for (const [key, el] of this.idx) {
      el.refs = (this.specs.get(key) ?? []).map((s) => {
        if (s.hint === "key") return s.ref;
        const cands = byDisplay.get(s.ref) ?? [];
        if (s.hint)
          for (const nk of s.hint) {
            const hit = cands.find((c) => this.idx.get(c)!.nodeKey === nk);
            if (hit) return hit;
          }
        if (this.idx.has(s.ref)) return s.ref;
        return cands[0] ?? s.ref;
      });
    }
    return this.idx;
  }
}

/** Urutan tetap untuk analisis umum (ID ganda: yang lebih dulu mendapat kunci polos). */
const GENERIC_ORDER = [
  "kontinuitas_proker", "msdm_attraction", "msdm_recruitment", "msdm_onboarding", "msdm_development", "msdm_penilaian",
  "msdm_retention", "msdm_separation", "decision_making", "change_management", "risk_management",
];
const KNOWN = new Set([
  "stakeholder_internal", "stakeholder_eksternal", "faktor_internal", "faktor_eksternal", "ifas", "efas",
  "posisi_organisasi", "swot_matrix", "qspm", "cascading", "renstra", "grand_design",
]);
const SKIP_KEYS = new Set(["ahp", "ahpRaw", "ahpSets", "pairs", "evidence", "weights", "matrix", "chart", "raw", "diagram", "heat"]);

function genericKind(nodeKey: string): TraceKind {
  if (nodeKey === "kontinuitas_proker") return "proker";
  if (nodeKey.startsWith("msdm_")) return "msdm";
  if (nodeKey === "decision_making") return "decision";
  if (nodeKey === "change_management") return "change";
  if (nodeKey === "risk_management") return "risk";
  if (nodeKey.startsWith("custom_")) return "custom";
  return "element";
}

/**
 * Elemen umum: objek ber-`id` di mana pun dalam output. Rujukan = field rujukan + elemen ber-ID yang tersarang di
 * dalamnya dan ikut "berujung" (punya bukti/rujukan). Mengembalikan kunci elemen yang berujung (untuk induknya).
 */
function walkGeneric(ix: Indexer, nodeKey: string, x: unknown, depth: number): string[] {
  if (depth > 6) return [];
  if (Array.isArray(x)) return x.flatMap((v) => walkGeneric(ix, nodeKey, v, depth + 1));
  const o = obj(x);
  if (!o) return [];
  const childKeys: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (SKIP_KEYS.has(k) || !v || typeof v !== "object") continue;
    childKeys.push(...walkGeneric(ix, nodeKey, v, depth + 1));
  }
  const id = str(o.id);
  if (!id) return childKeys; // bukan elemen: teruskan elemen di dalamnya ke induk
  const specs = [...declaredRefs(o), ...keysOf(childKeys)];
  const ev = evidenceOf(o);
  const key = ix.add({ id, kind: genericKind(nodeKey), text: textOf(o, id), evidence: ev, nodeKey }, specs);
  // Elemen tanpa bukti maupun rujukan tetap terdaftar (bisa dicari), tetapi tidak dijadikan rujukan induknya.
  return specs.length || ev.length ? [key] : [];
}

/** Indeks elemen yang bisa ditelusuri, dari output analisis yang tersedia. */
export function buildTraceIndex(o: TraceOutputs): Map<string, TraceEl> {
  const ix = new Indexer();
  try {
    // 1. Faktor S/W/O/T berbukti (daun rantai)
    for (const nk of ["faktor_internal", "faktor_eksternal"]) {
      for (const f of arr(obj(o[nk])?.factors)) {
        const x = obj(f);
        const id = x && str(x.id);
        if (!x || !id) continue;
        ix.add({ id, kind: "factor", text: textOf(x, id), evidence: evidenceOf(x), nodeKey: nk });
      }
    }
    // 2. Strategi SO/WO/ST/WT (matriks SWOT) → faktor
    for (const s of arr(obj(o.swot_matrix)?.strategies)) {
      const x = obj(s);
      const id = x && str(x.id);
      if (!x || !id) continue;
      ix.add({ id, kind: "strategy", text: textOf(x, id), nodeKey: "swot_matrix" }, declaredRefs(x));
    }
    // 3. Cascading: aspek/misi → SO → SI → strategi
    for (const a of arr(obj(o.cascading)?.aspects)) {
      const ax = obj(a);
      const aid = ax && str(ax.id);
      if (!ax || !aid) continue;
      const objKeys: string[] = [];
      for (const so of arr(ax.objectives)) {
        const sx = obj(so);
        const sid = sx && str(sx.id);
        if (!sx || !sid) continue;
        const initKeys: string[] = [];
        for (const si of arr(sx.initiatives)) {
          const x = obj(si);
          const iid = x && str(x.id);
          if (!x || !iid) continue;
          initKeys.push(ix.add({ id: iid, kind: "initiative", text: textOf(x, iid), evidence: evidenceOf(x), nodeKey: "cascading" }, declaredRefs(x)));
        }
        objKeys.push(
          ix.add({ id: sid, kind: "objective", text: textOf(sx, sid), evidence: evidenceOf(sx), nodeKey: "cascading" }, [...keysOf(initKeys), ...declaredRefs(sx)]),
        );
      }
      const text = [str(ax.aspek), str(ax.misi)].filter(Boolean).join(": ") || aid;
      ix.add({ id: aid, kind: "mission", text, evidence: evidenceOf(ax), nodeKey: "cascading" }, [...keysOf(objKeys), ...declaredRefs(ax)]);
    }
    // 4. Renstra: misi (M1…, dari cascading) ← milestone ← arah kerja (→ SI cascading)
    const ren = obj(o.renstra);
    for (const m of arr(ren?.misiItems)) {
      const x = obj(m);
      const id = x && str(x.id);
      if (!x || !id) continue;
      const aspek = str(x.aspekId);
      ix.add({ id, kind: "mission", text: textOf(x, id), nodeKey: "renstra" }, [
        ...(aspek ? [{ ref: aspek, hint: ["cascading"] as const }] : []),
        ...declaredRefs(x),
      ]);
    }
    for (const y of arr(ren?.years)) {
      for (const m of arr(obj(y)?.milestones)) {
        const mx = obj(m);
        const mid = mx && str(mx.id);
        if (!mx || !mid) continue;
        const mSpecs = declaredRefs(mx);
        const mKey = ix.add({ id: mid, kind: "milestone", text: textOf(mx, mid), evidence: evidenceOf(mx), nodeKey: "renstra" }, mSpecs);
        const grounded = mSpecs.length > 0 || evidenceOf(mx).length > 0;
        for (const a of arr(mx.arah)) {
          const x = obj(a);
          const aid = x && str(x.id);
          if (!x || !aid) continue;
          ix.add({ id: aid, kind: "arah", text: textOf(x, aid), evidence: evidenceOf(x), nodeKey: "renstra" }, [
            ...declaredRefs(x),
            ...(grounded ? keysOf([mKey]) : []),
          ]);
        }
      }
    }
    // 5. Analisis lain (kontinuitas, MSDM, DM-CRM, kustom): elemen umum, urutan tetap
    const rest = Object.keys(o).filter((k) => !KNOWN.has(k) && o[k] !== undefined && o[k] !== null);
    rest.sort((a, b) => {
      const ia = GENERIC_ORDER.indexOf(a);
      const ib = GENERIC_ORDER.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
    });
    for (const nk of rest) walkGeneric(ix, nk, o[nk], 0);
  } catch {
    // output tak terduga: kembalikan apa yang sudah terkumpul
  }
  return ix.finish();
}

/** ID tampilan yang jelas: "A (renstra)" bila ID yang sama juga dipakai analisis lain. */
export function displayId(key: string, el: TraceEl | undefined): string {
  if (!el || key === el.id) return el?.id ?? key;
  return `${el.id} (${el.nodeKey ?? "?"})`;
}

/** Elemen lengkap bila punya bukti, atau punya rujukan yang semuanya ada dan lengkap. */
export function makeCompleteness(idx: Map<string, TraceEl>) {
  const memo = new Map<string, boolean>();
  const complete = (id: string, stack = new Set<string>()): boolean => {
    if (memo.has(id)) return memo.get(id)!;
    const el = idx.get(id);
    let ok: boolean;
    if (!el || stack.has(id)) ok = false;
    else if ((el.evidence?.length ?? 0) > 0) ok = true;
    else if (el.kind === "factor") ok = false;
    else {
      stack.add(id);
      ok = el.refs.length > 0 && el.refs.every((r) => complete(r, stack));
      stack.delete(id);
    }
    memo.set(id, ok);
    return ok;
  };
  return complete;
}

export function traceTree(idx: Map<string, TraceEl>, id: string, depth = 0): TraceNode {
  const complete = makeCompleteness(idx);
  const build = (key: string, d: number): TraceNode => {
    const el = idx.get(key);
    if (!el) return { id: key, kind: "element", text: "(ID tidak ditemukan)", refs: [], found: false, complete: false, children: [] };
    return { ...el, found: true, complete: complete(key), children: d > 8 ? [] : el.refs.map((r) => build(r, d + 1)) };
  };
  return build(id, depth);
}

/** Jenis yang WAJIB berujung pada bukti (rantai inti Excel); jenis lain hanya diperiksa bila punya rujukan. */
const CORE: TraceKind[] = ["strategy", "initiative", "objective", "mission"];

function isTarget(el: TraceEl) {
  if (el.kind === "factor") return false;
  if (CORE.includes(el.kind)) return true;
  return el.refs.length > 0;
}

/** Cek trace_complete: elemen inti dan elemen yang menyatakan rujukan harus berujung pada kutipan sumber. */
export function checkTraceComplete(o: TraceOutputs) {
  const idx = buildTraceIndex(o);
  const complete = makeCompleteness(idx);
  const targets = [...idx.entries()].filter(([, e]) => isTarget(e));
  const broken: { id: string; reason: string }[] = [];
  for (const [key, t] of targets) {
    if (complete(key)) continue;
    const missing = t.refs.filter((r) => !idx.has(r));
    const weak = t.refs.filter((r) => idx.has(r) && !complete(r)).map((r) => displayId(r, idx.get(r)));
    broken.push({
      id: displayId(key, t),
      reason: missing.length
        ? `rujukan tidak ada: ${missing.join(", ")}`
        : t.refs.length === 0
          ? t.kind === "initiative"
            ? "inisiatif tidak merujuk strategi mana pun"
            : "tidak punya rujukan"
          : `rantai rujukan tidak sampai ke kutipan dokumen atau jawaban pengguna (lewat ${[...new Set(weak)].slice(0, 4).join(", ")})`,
    });
  }
  return { total: targets.length, complete: targets.length - broken.length, broken };
}

/** Teks rantai: "SI1 → SO2 → (S1 [C3] | O2 [C7])". */
export function chainText(idx: Map<string, TraceEl>, key: string, depth = 0, seen = new Set<string>()): string {
  const el = idx.get(key);
  if (!el) return `${key} (tidak ada)`;
  const ev = el.evidence?.length ? ` [${[...new Set(el.evidence.map((e) => e.chunkId))].join(", ")}]` : "";
  const id = displayId(key, el);
  if (depth > 6 || seen.has(key)) return id + ev;
  if (!el.refs.length) return id + ev;
  const next = new Set(seen).add(key);
  const subs = el.refs.slice(0, 6).map((r) => chainText(idx, r, depth + 1, next));
  const more = el.refs.length > 6 ? ` | +${el.refs.length - 6}` : "";
  const s = `${id}${ev} → ${subs.length > 1 ? `(${subs.join(" | ")}${more})` : subs[0]}`;
  return s.length > 600 ? s.slice(0, 600) + "…" : s;
}

/** Rantai semua elemen yang diperiksa (untuk lampiran jejak bukti). */
export function traceChains(o: TraceOutputs): TraceChain[] {
  const idx = buildTraceIndex(o);
  const complete = makeCompleteness(idx);
  return [...idx.entries()]
    .filter(([, e]) => isTarget(e))
    .map(([k, e]) => ({ id: displayId(k, e), kind: e.kind, nodeKey: e.nodeKey, text: e.text, path: chainText(idx, k), complete: complete(k) }));
}
