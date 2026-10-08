// Metadata node yang aman dipakai di komponen client (kanvas, panel, anotasi).
import type { FormulaDoc } from "@/lib/sheets/grid";
import { NODES, NODE_KEYS, type NodeKey } from "./registry";
import type { NodeGroup } from "./types";

export type NodeMeta = {
  key: NodeKey;
  label: string;
  phase: 1 | 2;
  group: NodeGroup;
  sheetName: string;
  deps: NodeKey[];
  kind: "llm" | "code";
  description: string;
  computedBy: string;
  checks: { name: string; kind: "code" | "llm"; description: string }[];
  hasValidator: boolean;
  formulas: FormulaDoc[];
};

export const NODE_META: Record<NodeKey, NodeMeta> = Object.fromEntries(
  NODE_KEYS.map((k) => {
    const d = NODES[k];
    return [
      k,
      {
        key: k,
        label: d.label,
        phase: d.phase,
        group: d.group,
        sheetName: d.sheetName,
        deps: d.deps,
        kind: d.kind,
        description: d.description,
        computedBy: d.computedBy,
        checks: d.checks,
        hasValidator: !!d.validate && d.checks.length > 0,
        formulas: d.formulas ?? [],
      },
    ];
  }),
) as Record<NodeKey, NodeMeta>;

export const nodeLabel = (k: string) => NODE_META[k as NodeKey]?.label ?? k;
export { NODE_KEYS };
export type { NodeKey };
