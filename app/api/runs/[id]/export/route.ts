import { eq, sql } from "drizzle-orm";
import { getDb, queryRows, schema } from "@/lib/db/client";
import { handle, projectOfRun, requireProject } from "@/lib/access";
import { getNode } from "@/lib/nodes/registry";

/** Butir output untuk CSV; kunci lama/keluaran yang tidak cocok lagi menjadi satu baris kosong. */
function itemsOf(key: string, output: unknown): { id: string; text: string; detail?: string }[] {
  const empty = [{ id: "", text: "", detail: "" }];
  if (!output) return empty;
  try {
    const items = getNode(key).items(output);
    return Array.isArray(items) && items.length ? items : empty;
  } catch {
    return empty;
  }
}

type Ctx = { params: Promise<{ id: string }> };

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Mengekspor output run ke JSON atau CSV (satu baris per item) untuk laporan. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(await projectOfRun(id));
  const format = new URL(req.url).searchParams.get("format") ?? "json";
  const db = await getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, id));
  const nodeRuns = await db.select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, id));
  const costs = await queryRows<{ node_run_id: string; purpose: string; tokens: number; latency_ms: number }>(sql`
    SELECT l.node_run_id, l.purpose, SUM(l.tokens_in + l.tokens_out)::int AS tokens, SUM(l.latency_ms)::int AS latency_ms
    FROM llm_calls l JOIN node_runs nr ON nr.id = l.node_run_id
    WHERE nr.run_id = ${id} AND l.injection_id IS NULL GROUP BY l.node_run_id, l.purpose`);

  if (format === "csv") {
    const lines = [["run_id", "experiment_tag", "node_key", "status", "validator", "human", "validation_passed", "item_id", "text", "detail", "tokens_generate", "tokens_validate_repair"].join(",")];
    for (const nr of nodeRuns) {
      const tok = (p: string[]) => costs.filter((c) => c.node_run_id === nr.id && p.includes(c.purpose)).reduce((s, c) => s + c.tokens, 0);
      const items = itemsOf(nr.nodeKey, nr.output);
      for (const it of items)
        lines.push(
          [run.id, run.experimentTag, nr.nodeKey, nr.status, nr.validatorEnabled, nr.humanEnabled, nr.validationPassed, it.id, it.text, it.detail, tok(["generate"]), tok(["validate", "repair"])]
            .map(csvCell)
            .join(","),
        );
    }
    return new Response("﻿" + lines.join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="run-${id.slice(0, 8)}.csv"` },
    });
  }
  const body = JSON.stringify({ run, nodeRuns, costs }, null, 2);
  return new Response(body, {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="run-${id.slice(0, 8)}.json"` },
  });
});
