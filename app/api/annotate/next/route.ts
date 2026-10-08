import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { HttpError, handle, requireUser } from "@/lib/access";
import { NODES, getNode, isNodeKey } from "@/lib/nodes/registry";
import { isCustomKey } from "@/lib/nodes/custom";
import type { AnnotItem } from "@/lib/nodes/types";
import { getSetting } from "@/lib/experiment/parameters";
import { DEFAULT_CODEBOOK } from "@/lib/codebook";

/** Analisis yang dinilai penilai: disusun AI. Analisis yang dihitung program (posisi organisasi, grand design) dan kunci lama dilewati. */
const CODE_NODES = new Set<string>(["posisi_organisasi", "grand_design"]);
const annotatable = (key: string) => isCustomKey(key) || (isNodeKey(key) && !CODE_NODES.has(key) && NODES[key].kind !== "code");

/** Butir yang bisa dinilai; null bila output lama tidak cocok dengan bentuk analisis sekarang. */
function itemsOf(key: string, output: unknown): AnnotItem[] | null {
  if (!output) return null;
  try {
    const items = getNode(key).items(output);
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

/**
 * Item anotasi berikutnya untuk penilai bernama `annotator`, diambil acak (urutan berbeda per penilai),
 * TANPA experiment_tag, konfigurasi run, maupun ID run — anotasi buta.
 * Satu akun bersama: dua penilai dibedakan lewat nama, sehingga kappa tetap bisa dihitung.
 */
export const GET = handle(async (req: Request) => {
  await requireUser();
  const url = new URL(req.url);
  const annotator = (url.searchParams.get("annotator") ?? "").trim();
  if (!annotator) throw new HttpError(400, "Isi nama penilai");
  const nodeFilter = url.searchParams.get("nodeKey");
  const db = await getDb();

  const allowed = (
    await db
      .select({ id: schema.nodeRuns.id, nodeKey: schema.nodeRuns.nodeKey })
      .from(schema.nodeRuns)
      .where(eq(schema.nodeRuns.status, "done"))
  ).filter((r) => annotatable(r.nodeKey) && (!nodeFilter || r.nodeKey === nodeFilter));

  const mine = allowed.length
    ? await db
        .select({ nodeRunId: schema.annotations.nodeRunId })
        .from(schema.annotations)
        .where(and(eq(schema.annotations.annotator, annotator), inArray(schema.annotations.nodeRunId, allowed.map((a) => a.id))))
    : [];
  const done = new Set(mine.map((m) => m.nodeRunId));
  const remaining = allowed.filter((a) => !done.has(a.id));
  const codebook = await getSetting("codebook", DEFAULT_CODEBOOK);
  const nodeKeys = [...new Set(allowed.map((a) => a.nodeKey))];
  const progress = { done: done.size, total: allowed.length };
  if (!remaining.length) return { item: null, progress, codebook, nodeKeys };

  // Ambil acak; lewati output lama yang bentuknya tidak cocok lagi (maks. 20 percobaan).
  const order = [...remaining].sort(() => Math.random() - 0.5).slice(0, 20);
  for (const pick of order) {
    const [nr] = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.id, pick.id));
    if (!nr) continue;
    const items = itemsOf(nr.nodeKey, nr.output);
    if (!items?.length) continue;
    const def = getNode(nr.nodeKey);
    // Konteks: item analisis induk wajib (agar penilai bisa menilai rujukan), tanpa info konfigurasi.
    const parentKeys = isNodeKey(nr.nodeKey) ? NODES[nr.nodeKey].deps : [];
    const parents = parentKeys.length
      ? await db
          .select({ nodeKey: schema.nodeRuns.nodeKey, output: schema.nodeRuns.output })
          .from(schema.nodeRuns)
          .where(and(eq(schema.nodeRuns.runId, nr.runId), inArray(schema.nodeRuns.nodeKey, parentKeys)))
      : [];
    const context = parents
      .filter((p) => p.output && isNodeKey(p.nodeKey))
      .map((p) => ({ nodeKey: p.nodeKey, label: getNode(p.nodeKey).label, items: itemsOf(p.nodeKey, p.output) ?? [] }))
      .filter((c) => c.items.length);

    return {
      item: {
        nodeRunId: nr.id,
        nodeKey: nr.nodeKey,
        label: def.label,
        description: def.description,
        items,
        output: nr.output,
        evidence: nr.input?.evidence ?? [],
        context,
      },
      progress,
      codebook,
      nodeKeys,
    };
  }
  return { item: null, progress, codebook, nodeKeys };
});
