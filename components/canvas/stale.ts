// Analisis yang angkanya dihitung ulang karena analisis hulunya diubah manusia setelah analisis itu selesai.
import type { WorkflowGraph } from "@/lib/db/schema";
import { engineParents, processKeys } from "@/lib/engine/canvas";
import { staleSources } from "@/components/sheets/grid-utils";
import type { NodeState } from "./types";

/** Kunci analisis → kunci hulu yang diubah setelah analisis itu selesai (hanya yang tidak kosong). */
export function staleMap(graph: WorkflowGraph, nodes: Record<string, NodeState | undefined>): Map<string, string[]> {
  const keys = processKeys(graph);
  const parents = new Map(keys.map((k) => [k, k === "grand_design" ? [] : engineParents(graph, k)]));
  const out = new Map<string, string[]>();
  for (const k of keys) {
    if (k === "grand_design" || nodes[k]?.status !== "done") continue;
    const s = staleSources(k, (x) => parents.get(x) ?? [], (x) => nodes[x]);
    if (s.length) out.set(k, s);
  }
  return out;
}
