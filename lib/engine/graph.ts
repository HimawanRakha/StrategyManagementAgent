import type { WorkflowGraph } from "@/lib/db/schema";
import { NODES, isNodeKey } from "@/lib/nodes/registry";
import { engineGraph, templateGraph } from "./canvas";

export class Graph {
  readonly keys: string[];
  private par = new Map<string, string[]>();
  private chi = new Map<string, string[]>();

  constructor(public readonly g: WorkflowGraph) {
    this.keys = g.nodes.map((n) => n.key ?? n.id);
    for (const k of this.keys) {
      this.par.set(k, []);
      this.chi.set(k, []);
    }
    for (const e of g.edges) {
      if (!this.par.has(e.to) || !this.chi.has(e.from)) continue;
      if (!this.par.get(e.to)!.includes(e.from)) this.par.get(e.to)!.push(e.from);
      if (!this.chi.get(e.from)!.includes(e.to)) this.chi.get(e.from)!.push(e.to);
    }
  }

  get nodes() {
    return this.g.nodes;
  }
  parents(k: string) {
    return this.par.get(k) ?? [];
  }
  children(k: string) {
    return this.chi.get(k) ?? [];
  }

  /** Urutan topologis (Kahn); urutan stabil mengikuti urutan library node. Melempar bila ada siklus. */
  topoOrder(): string[] {
    // Urutan node pada graf (engineGraph sudah mengurutkan menurut alur canvas) menjadi penentu bila beberapa node sama-sama siap.
    const order = this.keys;
    const rank = (k: string) => order.indexOf(k);
    const indeg = new Map(this.keys.map((k) => [k, this.parents(k).length]));
    const ready = this.keys.filter((k) => indeg.get(k) === 0).sort((a, b) => rank(a) - rank(b));
    const out: string[] = [];
    while (ready.length) {
      const k = ready.shift()!;
      out.push(k);
      for (const c of this.children(k)) {
        indeg.set(c, indeg.get(c)! - 1);
        if (indeg.get(c) === 0) {
          ready.push(c);
          ready.sort((a, b) => rank(a) - rank(b));
        }
      }
    }
    if (out.length !== this.keys.length) throw new Error("Graf alur memiliki siklus");
    return out;
  }

  ancestors(k: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...this.parents(k)];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      stack.push(...this.parents(p));
    }
    return seen;
  }

  descendants(k: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...this.children(k)];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...this.children(c));
    }
    return seen;
  }
}

/** Cek graf kanvas: node dikenal, tanpa siklus, dan setiap dependensi node ada sebagai leluhurnya. */
export function validateGraph(g: WorkflowGraph): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const n of g.nodes) {
    const k = n.key ?? n.id;
    if (!isNodeKey(k)) errors.push(`Node tidak dikenal: ${k}`);
    if (keys.has(k)) errors.push(`Node ganda: ${k}`);
    keys.add(k);
  }
  const graph = new Graph(g);
  try {
    graph.topoOrder();
  } catch (e) {
    errors.push((e as Error).message);
    return errors;
  }
  for (const n of g.nodes) {
    const k = n.key ?? n.id;
    if (!isNodeKey(k)) continue;
    const anc = graph.ancestors(k);
    for (const d of NODES[k].deps) {
      if (!keys.has(d)) errors.push(`${NODES[k].label} membutuhkan node ${NODES[d].label}`);
      else if (!anc.has(d)) errors.push(`${NODES[k].label} harus tersambung (langsung atau tidak) dari ${NODES[d].label}`);
    }
  }
  return errors;
}

/** Graf mesin bawaan dari templat canvas: "mvp" sampai TOWS (fase 1) atau "full" rantai lengkap. */
export function defaultGraph(kind: "mvp" | "full"): WorkflowGraph {
  return engineGraph(templateGraph(kind));
}
