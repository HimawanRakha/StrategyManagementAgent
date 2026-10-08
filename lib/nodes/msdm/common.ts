// Bantuan bersama untuk tujuh node Manajemen SDM (attraction → recruitment → onboarding → development → penilaian →
// retention → separation). Modul murni (aman di client).
//
// Node MSDM tidak punya dependensi wajib; konteksnya diambil dari:
//  - hasil cascading/renstra bila ada di run (arah strategi organisasi, ID-nya boleh dirujuk lewat `refs`),
//  - hasil node MSDM sebelumnya bila ada (rantai templat: renstra → attraction → … → separation),
//  - dokumen dari node input yang tersambung (ctx.evidence).
import type { EvidenceChunk } from "@/lib/db/schema";
import type { CascadingComputed, RenstraComputed, StakeholderComputed } from "../contracts";
import type { Evidence } from "../schemas";
import type { AnnotItem, CheckResult, Failure, LlmSession, NodeContext, NodeKey } from "../types";
import { orgLine } from "../prompt";
import { sentencesOf } from "../heuristics";
import { checkQuotes, checkRefs, llmJudge, norm, result } from "@/lib/validators/common";

export type Ref = { id: string; text: string };
type Inputs = { inputs: Partial<Record<string, unknown>> };

/** Node hulu yang dibaca sebagai konteks (cukup kunci, label, dan cara membuat butir). */
export type Upstream = { key: NodeKey; label: string; items: (out: unknown) => AnnotItem[] };

const asArr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);

// ---------- Konteks strategi (cascading, renstra) ----------

/** Butir strategi yang boleh dirujuk lewat `refs`: sasaran & inisiatif (cascading), milestone & arah (renstra). */
export function strategyRefs(ctx: Inputs): Ref[] {
  const out = new Map<string, Ref>();
  const cas = ctx.inputs.cascading as CascadingComputed | undefined;
  for (const a of asArr(cas?.aspects))
    for (const o of asArr(a?.objectives)) {
      if (o?.id) out.set(o.id, { id: o.id, text: o.text ?? "" });
      for (const i of asArr(o?.initiatives)) if (i?.id) out.set(i.id, { id: i.id, text: i.text ?? "" });
    }
  const ren = ctx.inputs.renstra as RenstraComputed | undefined;
  for (const y of asArr(ren?.years))
    for (const m of asArr(y?.milestones)) {
      if (m?.id) out.set(m.id, { id: m.id, text: `Tahun ${y.tahun}: ${m.text ?? ""}` });
      for (const a of asArr(m?.arah)) if (a?.id) out.set(a.id, { id: a.id, text: `${a.text ?? ""}${a.target ? ` (target: ${a.target})` : ""}` });
    }
  return [...out.values()];
}

/** Ringkasan arah strategi untuk prompt. */
export function strategyBlock(ctx: Inputs): string {
  const lines: string[] = [];
  const cas = ctx.inputs.cascading as CascadingComputed | undefined;
  const ren = ctx.inputs.renstra as RenstraComputed | undefined;
  const visi = ren?.visi || cas?.visi;
  if (visi) lines.push(`Visi: ${visi}`);
  const misi = asArr(ren?.misi).length ? asArr(ren?.misi) : asArr(cas?.aspects).map((a) => a?.misi).filter(Boolean);
  if (misi.length) lines.push(`Misi:\n${misi.map((m, i) => `${i + 1}. ${m}`).join("\n")}`);
  if (ren?.sasaranUmum) lines.push(`Sasaran umum renstra: ${ren.sasaranUmum}`);
  const objs = asArr(cas?.aspects).flatMap((a) => asArr(a?.objectives).map((o) => `${o.id}: ${o.text}${asArr(o.initiatives).length ? ` (inisiatif: ${asArr(o.initiatives).map((i) => `${i.id} ${i.text}`).join("; ")})` : ""}`));
  if (objs.length) lines.push(`Sasaran strategis (cascading):\n${objs.join("\n")}`);
  const years = asArr(ren?.years).map(
    (y) => `Tahun ${y.tahun}${y.fokus ? ` — fokus: ${y.fokus}` : ""}\n${asArr(y.milestones).map((m) => `  ${m.id}: ${m.text}${asArr(m.arah).length ? ` | arah: ${asArr(m.arah).map((a) => `${a.id} ${a.text}`).join("; ")}` : ""}`).join("\n")}`,
  );
  if (years.length) lines.push(`Renstra:\n${years.join("\n")}`);
  return lines.length ? lines.join("\n\n") : "(belum ada hasil cascading/renstra di run ini — dasarkan pada dokumen dan profil organisasi)";
}

/** Jabatan pengurus dari stakeholder internal (bila ada) — dipakai mock recruitment/penilaian. */
export function internalPositions(ctx: Inputs): string[] {
  const st = ctx.inputs.stakeholder_internal as StakeholderComputed | undefined;
  const POS = /\b(ketua|wakil|sekretaris|bendahara|kepala|koordinator|kabiro|kadep|menteri|direktur|manajer|staf|staff|asisten|anggota pengurus)\b/i;
  const NOT = /\b(mahasiswa|dosen|alumni|dekan|rektor|pembina|fakultas|universitas|masyarakat|sponsor|mitra)\b/i;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of asArr(st?.roles)) {
    const j = (r?.jabatan ?? "").trim();
    if (!j || !POS.test(j) || NOT.test(j) || seen.has(j.toLowerCase())) continue;
    seen.add(j.toLowerCase());
    out.push(j);
  }
  return out;
}

// ---------- Konteks node MSDM sebelumnya ----------

/** Butir node hulu yang sudah selesai (aman bila output tidak lengkap). */
export function upstreamItems(ctx: Inputs, ups: Upstream[]): { up: Upstream; items: AnnotItem[] }[] {
  const out: { up: Upstream; items: AnnotItem[] }[] = [];
  for (const up of ups) {
    const o = ctx.inputs[up.key];
    if (o === undefined || o === null) continue;
    try {
      out.push({ up, items: up.items(o) });
    } catch {
      /* output lama/rusak: abaikan */
    }
  }
  return out;
}

export function upstreamBlock(ctx: Inputs, ups: Upstream[]): string {
  const xs = upstreamItems(ctx, ups);
  if (!xs.length) return "(belum ada hasil analisis MSDM sebelumnya di run ini)";
  return xs.map(({ up, items }) => `## ${up.label}\n${items.map((i) => `${i.id}: ${i.text}${i.detail ? ` — ${i.detail}` : ""}`).join("\n")}`).join("\n\n");
}

/** Semua ID yang sah untuk `refs`: butir strategi + butir node MSDM hulu. */
export function validRefIds(ctx: Inputs, ups: Upstream[]): Set<string> {
  const ids = new Set(strategyRefs(ctx).map((r) => r.id));
  for (const { items } of upstreamItems(ctx, ups)) for (const i of items) ids.add(i.id);
  return ids;
}

/** Teks konteks standar untuk prompt node MSDM. */
export function contextBlock(ctx: NodeContext, ups: Upstream[]): string {
  return `${orgLine(ctx)}

ARAH STRATEGI ORGANISASI (ID boleh dirujuk di "refs"):
${strategyBlock(ctx)}

HASIL MSDM SEBELUMNYA (ID boleh dirujuk di "refs"):
${upstreamBlock(ctx, ups)}`;
}

// ---------- Bukti dokumen untuk mock ----------

const KW = (s: string) => [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).map((w) => w.slice(0, 5)))];

/** Kalimat dokumen yang paling cocok dengan kata kunci (kutipan persis), minimal `min` kata kunci cocok. */
export function findQuote(evidence: EvidenceChunk[], query: string, used: Set<string> = new Set(), min = 2): Evidence | null {
  const kws = KW(query);
  let best: Evidence | null = null;
  let bestScore = min - 1;
  for (const c of evidence) {
    for (const s of sentencesOf(c.content)) {
      if (used.has(s)) continue;
      const words = s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      const score = kws.filter((k) => words.some((w) => w.startsWith(k))).length;
      if (score > bestScore) {
        best = { chunkId: c.id, quote: s };
        bestScore = score;
      }
    }
  }
  if (best) used.add(best.quote);
  return best;
}

// ---------- Pemeriksaan bersama ----------

export const QUOTE_CHECK = { name: "quote_exists", kind: "code" as const, description: "Kutipan bukti tidak ditemukan di potongan dokumen yang dirujuk" };
export const REF_CHECK = { name: "ref_exists", kind: "code" as const, description: "Butir merujuk ID strategi/analisis MSDM sebelumnya yang tidak ada" };
export const GROUNDED_CHECK = {
  name: "grounded",
  kind: "code" as const,
  description: "Butir tidak punya bukti dokumen maupun rujukan ke strategi/analisis sebelumnya",
};

type Grounded = { id: string; evidence?: Evidence[]; refs?: string[] };

export function quoteCheck(items: Grounded[], evidence: EvidenceChunk[]): CheckResult {
  const r = checkQuotes(
    items.filter((i) => i.evidence?.length).map((i) => ({ id: i.id, evidence: i.evidence ?? [] })),
    evidence,
  );
  // Pesan bawaan memakai kata "Faktor"; ganti agar sesuai butir MSDM.
  return { ...r, failures: r.failures.map((f) => ({ ...f, message: f.message.replace(/^Faktor /, "Butir ") })) };
}

export function refCheck(items: Grounded[], valid: Set<string>): CheckResult {
  return checkRefs(
    "ref_exists",
    items.map((i) => ({ id: i.id, refs: i.refs ?? [] })),
    valid,
    "butir strategi/analisis MSDM",
  );
}

/**
 * Setiap butir wajib punya bukti dokumen atau rujukan. Dilewati bila tidak ada dokumen maupun konteks yang bisa dirujuk
 * (tidak adil menuntut bukti yang tidak tersedia).
 */
export function groundedCheck(items: Grounded[], ctx: NodeContext, valid: Set<string>, what = "Butir"): CheckResult {
  if (!ctx.evidence.length && !valid.size) return result("grounded", "code", []);
  const failures: Failure[] = items
    .filter((i) => !(i.evidence ?? []).length && !(i.refs ?? []).length)
    .map((i) => ({ check: "grounded", itemId: i.id, message: `${what} ${i.id} tidak punya kutipan dokumen maupun rujukan (refs) ke strategi/analisis sebelumnya.` }));
  return result("grounded", "code", failures);
}

/** ID ganda atau kosong dalam satu daftar. */
export function idProblems(list: { id: string }[], what: string, check: string): Failure[] {
  const seen = new Set<string>();
  const out: Failure[] = [];
  for (const x of list) {
    const id = (x.id ?? "").trim();
    if (!id) out.push({ check, message: `${what}: ada butir tanpa ID.` });
    else if (seen.has(id)) out.push({ check, itemId: id, message: `${what}: ID ${id} dipakai lebih dari sekali.` });
    seen.add(id);
  }
  return out;
}

/** Jumlah butir di luar rentang. */
export function countProblem(n: number, min: number, max: number, what: string, check: string, itemId?: string): Failure[] {
  if (n < min) return [{ check, itemId, message: `${what}: baru ${n} butir, minimal ${min}.` }];
  if (n > max) return [{ check, itemId, message: `${what}: ${n} butir, maksimal ${max}.` }];
  return [];
}

export const blank = (s: string | null | undefined) => !(s ?? "").trim();

/** Cek LLM bersama: relevansi butir dengan arah strategi organisasi. */
export function strategyJudge(
  llm: LlmSession,
  ctx: NodeContext,
  check: string,
  instruction: string,
  items: { id: string; text: string }[],
  extra = "",
): Promise<CheckResult> {
  return llmJudge(llm, check, instruction, items, `${orgLine(ctx)}\n\nArah strategi:\n${strategyBlock(ctx)}${extra ? `\n\n${extra}` : ""}`);
}

/** Dua teks hampir sama (untuk mendeteksi butir yang bertentangan/berulang). */
export function similar(a: string, b: string): boolean {
  const wa = new Set(norm(a).split(/\W+/).filter((w) => w.length > 3));
  const wb = new Set(norm(b).split(/\W+/).filter((w) => w.length > 3));
  if (!wa.size || !wb.size) return norm(a) === norm(b);
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size) >= 0.8 && inter >= 3;
}

// ---------- Tampilan ----------

/** "1. a\n2. b" */
export const numbered = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");

/** Catatan sel: alasan + kutipan bukti. */
export function noteOf(reason: string | undefined, evidence: Evidence[] = [], refs: string[] = []): string | undefined {
  const parts = [
    reason?.trim() ? reason.trim() : "",
    refs.length ? `Dasar: ${refs.join(", ")}` : "",
    ...evidence.map((e) => `[${e.chunkId}] "${e.quote}"`),
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

export const evidenceRefs = (evidence: Evidence[] = []) => (evidence.length ? evidence.map((e) => e.chunkId) : undefined);
