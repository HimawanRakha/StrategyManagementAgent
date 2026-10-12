import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { handle, projectOfNodeRun, requireProject } from "@/lib/access";
import { loadContext } from "@/lib/engine/run-node";
import { resolveNode } from "@/lib/engine/resolve";
import { defaultModel } from "@/lib/llm/provider";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Prompt yang dikirim ke AI untuk node run ini: System + User disusun ulang dengan templat analisis, pengaturan node di
 * canvas, hasil analisis sebelumnya, dan potongan dokumen yang TERSIMPAN di node run (bukti saat dijalankan), beserta
 * kueri pencarian dokumen dan konfigurasi panggilan API. Tidak memanggil AI.
 */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfNodeRun(id));
  const db = await getDb();
  const { nr, run, ctx: nctx, graph } = await loadContext(id);
  const [lastReview] = await db
    .select({ approved: schema.reviews.approved, changes: schema.reviews.changes })
    .from(schema.reviews)
    .where(eq(schema.reviews.nodeRunId, id))
    .orderBy(desc(schema.reviews.startedAt))
    .limit(1);
  const rejectNote = lastReview?.approved === false ? ((lastReview.changes as { note?: string } | null)?.note ?? null) : null;
  const { def, settings, parents, label } = resolveNode(nr.nodeKey, graph, rejectNote);
  nctx.parents = parents;

  // Model yang benar-benar dipakai saat analisis ini disusun (bisa berbeda dari pengaturan sekarang).
  const [used] = await db
    .select({ model: schema.llmCalls.model })
    .from(schema.llmCalls)
    .where(and(eq(schema.llmCalls.nodeRunId, id), eq(schema.llmCalls.purpose, "generate")))
    .orderBy(desc(schema.llmCalls.createdAt))
    .limit(1);

  const queries = (def.queries?.(nctx) ?? []).map((q) => ({ focus: q.focus, text: q.text, k: q.k ?? 8, valuesOnly: !!q.valuesOnly }));
  const prompt = def.kind === "code" || !def.prompt ? null : def.prompt(nctx);
  return {
    nodeKey: nr.nodeKey,
    label,
    kind: def.kind,
    computedBy: def.computedBy,
    hasRun: !!nr.startedAt,
    evidenceCount: nctx.evidence.length,
    queries,
    system: prompt?.system ?? null,
    user: prompt?.user ?? null,
    config: {
      model: used?.model || settings.model || run.config.model || defaultModel(),
      temperature: settings.temperature ?? run.config.temperature ?? Number(process.env.LLM_TEMPERATURE ?? 0.2),
      responseMimeType: "application/json",
    },
  };
});
