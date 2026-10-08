import "server-only";
// Edit manusia pada hasil analisis: ubah nilai di output mentah (usulan AI) → validasi skema → hitung ulang kalkulator
// node itu → hitung ulang kalkulator semua analisis sesudahnya (tanpa memanggil AI). Setiap perubahan dicatat.
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { NodeEdit } from "@/lib/db/schema";
import { Graph } from "./graph";
import { engineGraph } from "./canvas";
import { loadContext, refreshRunStatus } from "./run-node";
import { resolveNode } from "./resolve";

export type EditInput = { path: (string | number)[]; value: unknown };

export class EditError extends Error {}

function getAt(obj: unknown, path: (string | number)[]): unknown {
  let cur = obj as Record<string | number, unknown> | undefined;
  for (const k of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k] as Record<string | number, unknown> | undefined;
  }
  return cur;
}

function setAt(obj: unknown, path: (string | number)[], value: unknown) {
  if (!path.length) throw new EditError("Path edit kosong");
  let cur = obj as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur?.[path[i]];
    if (next === null || next === undefined || typeof next !== "object") throw new EditError(`Bagian "${path.slice(0, i + 1).join(".")}" tidak ditemukan`);
    cur = next as Record<string | number, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Output mentah node run: kolom raw, atau output lama (sebelum kolom raw ada) yang disaring skema. */
function rawOf(nr: { raw: unknown; output: unknown }, parse: (x: unknown) => { success: boolean; data?: unknown }) {
  if (nr.raw !== null && nr.raw !== undefined) return structuredClone(nr.raw);
  const p = parse(nr.output);
  if (!p.success) throw new EditError("Hasil lama tidak bisa diubah; jalankan ulang analisis ini dulu.");
  return structuredClone(p.data);
}

/** Terapkan perubahan pada satu node run lalu hitung ulang turunannya. */
export async function applyEdits(nodeRunId: string, edits: EditInput[]) {
  const db = await getDb();
  const { nr, ctx, graph } = await loadContext(nodeRunId);
  if (nr.status !== "done" && nr.status !== "needs_review") throw new EditError("Analisis ini belum punya hasil untuk diubah.");
  const def = resolveNode(nr.nodeKey, graph).def;
  const raw = rawOf(nr, (x) => def.schema.safeParse(x));
  const at = new Date().toISOString();
  const log: NodeEdit[] = [];
  for (const e of edits) {
    const from = getAt(raw, e.path);
    if (from === undefined && getAt(raw, e.path.slice(0, -1)) === undefined) throw new EditError(`Sel "${e.path.join(".")}" tidak ditemukan`);
    if (JSON.stringify(from) === JSON.stringify(e.value)) continue;
    setAt(raw, e.path, e.value);
    log.push({ path: e.path, from: from ?? null, to: e.value, at });
  }
  if (!log.length) return { changed: 0, recomputed: [] as string[] };
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new EditError(`Nilai tidak valid di ${i?.path.join(".") || "hasil"}: ${i?.message ?? "tidak sesuai aturan"}`);
  }
  const out = parsed.data;
  // Saat menunggu tinjauan, output tetap mentah (kalkulator dijalankan setelah disetujui).
  const final = nr.status === "done" && def.compute ? def.compute(out, ctx) : out;
  await db
    .update(schema.nodeRuns)
    .set({ raw: out, output: final, edits: [...(nr.edits ?? []), ...log], editedAt: new Date() })
    .where(eq(schema.nodeRuns.id, nodeRunId));
  const recomputed = nr.status === "done" ? await recomputeDownstream(nr.runId, nr.nodeKey) : [];
  return { changed: log.length, recomputed };
}

/** Kembalikan semua perubahan manusia (urutan terbalik) ke usulan AI semula. */
export async function revertEdits(nodeRunId: string) {
  const db = await getDb();
  const { nr, ctx, graph } = await loadContext(nodeRunId);
  const def = resolveNode(nr.nodeKey, graph).def;
  if (!nr.edits?.length) return { changed: 0, recomputed: [] as string[] };
  const raw = rawOf(nr, (x) => def.schema.safeParse(x));
  for (const e of [...nr.edits].reverse()) setAt(raw, e.path, e.from);
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) throw new EditError("Usulan AI semula tidak bisa dipulihkan; jalankan ulang analisis ini.");
  const final = nr.status === "done" && def.compute ? def.compute(parsed.data, ctx) : parsed.data;
  await db.update(schema.nodeRuns).set({ raw: parsed.data, output: final, edits: [], editedAt: new Date() }).where(eq(schema.nodeRuns.id, nodeRunId));
  const recomputed = nr.status === "done" ? await recomputeDownstream(nr.runId, nr.nodeKey) : [];
  return { changed: nr.edits.length, recomputed };
}

/**
 * Hitung ulang kalkulator analisis sesudah `fromKey` (urut alur) memakai output terbaru induknya.
 * Isi teks dari AI tidak berubah — tampilan menandai analisis yang induknya diubah setelah analisis itu selesai.
 */
export async function recomputeDownstream(runId: string, fromKey: string): Promise<string[]> {
  const db = await getDb();
  const nrs = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, runId));
  if (!nrs.length) return [];
  const { graph: canvas } = await loadContext(nrs[0].id);
  const g = new Graph(engineGraph(canvas));
  const below = g.descendants(fromKey);
  const done: string[] = [];
  for (const key of g.topoOrder()) {
    if (!below.has(key) || key === "grand_design") continue;
    const [nr] = await db.select().from(schema.nodeRuns).where(and(eq(schema.nodeRuns.runId, runId), eq(schema.nodeRuns.nodeKey, key)));
    if (!nr || nr.status !== "done") continue;
    const { ctx } = await loadContext(nr.id);
    const def = resolveNode(key, canvas).def;
    if (!def.compute) continue;
    let raw: unknown;
    try {
      raw = rawOf(nr, (x) => def.schema.safeParse(x));
    } catch {
      continue;
    }
    try {
      const final = def.compute(raw, ctx);
      await db.update(schema.nodeRuns).set({ output: final }).where(eq(schema.nodeRuns.id, nr.id));
      done.push(key);
    } catch (e) {
      console.warn(`[edit] hitung ulang ${key} gagal:`, (e as Error).message);
    }
  }
  await refreshRunStatus(runId);
  return done;
}
