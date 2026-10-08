// Canvas alur berpikir. Modul ini murni (aman dipakai di client).
//
// Jenis elemen: input (dokumen), process (analisis bawaan atau kustom), output (dokumen hasil),
// validator (pemeriksaan otomatis), review (tinjauan manusia), note (catatan tempel).
//
// Urutan eksekusi: dependensi wajib analisis bawaan (registry) DITAMBAH semua panah antar-analisis di canvas
// (panah = "hasil analisis ini dipakai analisis itu"), sehingga alur tetap benar walau panah wajib belum digambar.
// Validator dan tinjauan berlaku untuk node proses yang panahnya masuk ke elemen tersebut — penempatannya terlihat di canvas.
import type { CustomSpec, GraphNode, NodeSettings, ValidatorSettings, WorkflowGraph } from "@/lib/db/schema";
import { NODES, isNodeKey, type NodeKey } from "@/lib/nodes/registry";
import { customKeyOf, isCustomKey } from "@/lib/nodes/custom";

type LooseGraph = { nodes: Partial<GraphNode>[]; edges: { from: string; to: string }[] };

/** Ubah graf lama ({key} saja) ke bentuk canvas ({id, type, key}). */
export function normalizeGraph(g: LooseGraph | WorkflowGraph | null | undefined): WorkflowGraph {
  const nodes: GraphNode[] = (g?.nodes ?? []).map((n) => {
    const raw = n as GraphNode;
    if (raw.type) return { ...raw, id: raw.id ?? raw.key ?? crypto.randomUUID() };
    return { ...raw, id: raw.key!, type: "process" };
  });
  // Panah ganda (sama asal dan tujuan) disimpan sekali saja.
  const edges = (g?.edges ?? []).filter((e, i, all) => all.findIndex((x) => x.from === e.from && x.to === e.to) === i);
  return { nodes, edges };
}

/** Kunci mesin untuk node proses: node_key bawaan, atau "custom_<id>" untuk node kustom. */
export function processKeyOf(n: GraphNode): string | null {
  if (n.type !== "process") return null;
  if (n.key === "custom" || n.custom) return customKeyOf(n.id);
  return n.key && isNodeKey(n.key) ? n.key : null;
}

/** Node canvas untuk kunci mesin tertentu. */
export function canvasNodeOf(g: WorkflowGraph, key: string): GraphNode | undefined {
  return g.nodes.find((n) => processKeyOf(n) === key);
}

/** Label tampilan sebuah analisis (nama kustom atau label bawaan; bisa diganti pengguna). */
export function labelOf(g: WorkflowGraph, key: string): string {
  const n = canvasNodeOf(g, key);
  if (n?.label) return n.label;
  if (n?.custom?.name) return n.custom.name;
  return isNodeKey(key) ? NODES[key].label : "Proses kustom";
}

/** Node proses yang panahnya (langsung, atau lewat validator/tinjauan/catatan) masuk ke node `id`. */
export function processParents(g: WorkflowGraph, id: string): GraphNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphNode>();
  const seen = new Set<string>();
  const stack = g.edges.filter((e) => e.to === id).map((e) => e.from);
  while (stack.length) {
    const from = stack.pop()!;
    if (seen.has(from)) continue;
    seen.add(from);
    const n = byId.get(from);
    if (!n) continue;
    if (n.type === "process") out.set(n.id, n);
    else if (n.type === "validator" || n.type === "review" || n.type === "note") stack.push(...g.edges.filter((e) => e.to === from).map((e) => e.from));
  }
  return [...out.values()];
}

/** ID node input yang panahnya masuk langsung ke node proses `id` (dokumennya wajib dibaca node itu). */
export function connectedInputIds(g: WorkflowGraph, id: string): string[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return g.edges.filter((e) => e.to === id && byId.get(e.from)?.type === "input").map((e) => e.from);
}

/** Elemen validator/tinjauan yang menerima panah dari node proses `id`. */
export function attachedChecks(g: WorkflowGraph, id: string) {
  const targets = g.edges.filter((e) => e.from === id).map((e) => g.nodes.find((n) => n.id === e.to)).filter(Boolean) as GraphNode[];
  return { validator: targets.find((n) => n.type === "validator") ?? null, review: targets.find((n) => n.type === "review") ?? null };
}

/** Kunci analisis yang ada di canvas (belum berurutan); grand_design ikut bila ada node output. */
function presentKeys(g: WorkflowGraph): string[] {
  const builtins = new Set<string>();
  const customs: string[] = [];
  for (const n of g.nodes) {
    const k = processKeyOf(n);
    if (!k) continue;
    if (isCustomKey(k)) customs.push(k);
    else builtins.add(k);
  }
  if (g.nodes.some((n) => n.type === "output")) builtins.add("grand_design");
  const ordered = (Object.keys(NODES) as NodeKey[]).filter((k) => builtins.has(k) && k !== "grand_design");
  return [...ordered, ...customs, ...(builtins.has("grand_design") ? ["grand_design"] : [])];
}

/** Induk mesin untuk sebuah analisis: dependensi wajib bawaan + semua analisis yang panahnya masuk (langsung atau lewat validator/tinjauan). */
export function engineParents(g: WorkflowGraph, key: string): string[] {
  const keys = new Set(presentKeys(g));
  const parents = new Set<string>();
  if (isNodeKey(key) && key !== "grand_design") for (const d of NODES[key].deps) if (keys.has(d)) parents.add(d);
  const node = canvasNodeOf(g, key);
  if (node) {
    for (const p of processParents(g, node.id)) {
      const pk = processKeyOf(p);
      if (pk && pk !== key) parents.add(pk);
    }
  }
  return [...parents];
}

/**
 * Graf untuk mesin: satu node per analisis. Penempatan validator/tinjauan diambil dari elemen di canvas.
 * grand_design (ringkasan & kompilasi untuk node output) dijalankan setelah semua analisis lain.
 */
export function engineGraph(canvas: WorkflowGraph): WorkflowGraph {
  const present = presentKeys(canvas);
  const edges: { from: string; to: string }[] = [];
  for (const k of present) {
    if (k === "grand_design") {
      for (const o of present) if (o !== "grand_design") edges.push({ from: o, to: k });
      continue;
    }
    for (const p of engineParents(canvas, k)) edges.push({ from: p, to: k });
  }
  const keys = flowOrder(canvas, present, edges);
  return {
    nodes: keys.map((k) => {
      const n = canvasNodeOf(canvas, k);
      const att = n ? attachedChecks(canvas, n.id) : { validator: null, review: null };
      return { id: k, type: "process", key: k, validator: !!att.validator, human: !!att.review };
    }),
    edges,
  };
}

/**
 * Urutan alur: topologis (langkah tidak pernah mendahului langkah yang dibutuhkannya); bila beberapa langkah sama-sama
 * siap, yang lebih KIRI di canvas didahulukan, lalu yang lebih atas — sesuai cara flowchart dibaca. grand_design selalu terakhir.
 * Urutan ini dipakai untuk eksekusi, panel Perhitungan, dan Laporan.
 */
function flowOrder(g: WorkflowGraph, keys: string[], edges: { from: string; to: string }[]): string[] {
  const pos = (k: string) => {
    if (k === "grand_design") return { x: Infinity, y: Infinity };
    const p = canvasNodeOf(g, k)?.position;
    return p ? { x: p.x, y: p.y } : { x: 1e9, y: keys.indexOf(k) };
  };
  const before = (a: string, b: string) => {
    const pa = pos(a);
    const pb = pos(b);
    // posisi x yang berbeda kurang dari 20 px dianggap satu kolom → urutkan dari atas
    if (Math.abs(pa.x - pb.x) >= 20) return pa.x - pb.x;
    return pa.y - pb.y || keys.indexOf(a) - keys.indexOf(b);
  };
  const indeg = new Map(keys.map((k) => [k, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const ready = keys.filter((k) => indeg.get(k) === 0);
  const out: string[] = [];
  while (ready.length) {
    ready.sort(before);
    const k = ready.shift()!;
    out.push(k);
    for (const e of edges.filter((x) => x.from === k)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) ready.push(e.to);
    }
  }
  // Panah melingkar (sudah diperingatkan): sisanya ditaruh di akhir agar tetap tampil.
  for (const k of keys) if (!out.includes(k)) out.push(k);
  return out;
}

/** Kunci analisis di canvas dalam urutan alur (lihat flowOrder). */
export function processKeys(g: WorkflowGraph): string[] {
  return engineGraph(g).nodes.map((n) => n.key!);
}

/** Pengaturan efektif untuk analisis `key`: pengaturan node + spesifikasi kustom + pengaturan validatornya. */
export function settingsOf(g: WorkflowGraph, key: string): {
  settings: NodeSettings;
  validator: ValidatorSettings | null;
  custom: CustomSpec | null;
  label: string;
} {
  const n = canvasNodeOf(g, key);
  const att = n ? attachedChecks(g, n.id) : { validator: null, review: null };
  return {
    settings: n?.settings ?? {},
    validator: att.validator ? (att.validator.settings ?? {}) : null,
    custom: n?.custom ?? null,
    label: labelOf(g, key),
  };
}

function hasCycle(eg: WorkflowGraph) {
  const indeg = new Map(eg.nodes.map((n) => [n.id, 0]));
  for (const e of eg.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const q = [...indeg].filter(([, d]) => d === 0).map(([k]) => k);
  let seen = 0;
  while (q.length) {
    const k = q.shift()!;
    seen++;
    for (const e of eg.edges.filter((x) => x.from === k)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) q.push(e.to);
    }
  }
  return seen !== eg.nodes.length;
}

export type CanvasWarning = { nodeId: string; message: string; missing?: NodeKey[] };

/** Peringatan yang membantu pengguna menyusun alur. */
export function canvasWarnings(canvas: WorkflowGraph): CanvasWarning[] {
  const out: CanvasWarning[] = [];
  const keys = new Set(canvas.nodes.filter((n) => n.type === "process").map((n) => n.key));
  const seen = new Set<string>();
  for (const n of canvas.nodes) {
    if (n.type === "process" && (n.key === "custom" || n.custom)) {
      if (!n.custom?.name?.trim() || !n.custom?.instruction?.trim())
        out.push({ nodeId: n.id, message: "Isi nama dan instruksi proses kustom" });
      else if (n.custom.format === "table" && !(n.custom.columns ?? []).some((c) => c.trim()))
        out.push({ nodeId: n.id, message: "Bentuk tabel dipilih tetapi belum ada nama kolom" });
      continue;
    }
    if (n.type === "validator" || n.type === "review") {
      if (!canvas.edges.some((e) => e.to === n.id && canvas.nodes.find((x) => x.id === e.from)?.type === "process"))
        out.push({ nodeId: n.id, message: `Tarik panah dari node proses ke ${n.type === "validator" ? "validator" : "tinjauan"} ini` });
      continue;
    }
    if (n.type !== "process" || !n.key) continue;
    if (!isNodeKey(n.key)) {
      out.push({ nodeId: n.id, message: `Analisis tidak dikenal: ${n.key}` });
      continue;
    }
    if (seen.has(n.key)) out.push({ nodeId: n.id, message: `${NODES[n.key].label} sudah ada di canvas (dihitung sekali)` });
    seen.add(n.key);
    const missing = NODES[n.key].deps.filter((d) => !keys.has(d));
    if (missing.length) out.push({ nodeId: n.id, missing, message: `Butuh ${missing.map((m) => NODES[m].label).join(", ")} di canvas` });
  }
  if (hasCycle(engineGraph(canvas))) out.push({ nodeId: "", message: "Ada panah melingkar antar-analisis; hapus salah satu panah" });
  if (!canvas.nodes.some((n) => n.type === "input")) out.push({ nodeId: "", message: "Belum ada node input dokumen" });
  return out;
}

/** Analisis di hulu node output (mengikuti panah, termasuk kustom) beserta dependensinya. */
export function upstreamProcesses(canvas: WorkflowGraph, outputId: string): string[] {
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = canvas.edges.filter((e) => e.to === outputId).map((e) => e.from);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...canvas.edges.filter((e) => e.to === id).map((e) => e.from));
  }
  const keys = new Set<string>();
  const addWithDeps = (k: string) => {
    if (keys.has(k)) return;
    keys.add(k);
    for (const p of engineParents(canvas, k)) addWithDeps(p);
  };
  for (const id of seen) {
    const n = byId.get(id);
    const k = n ? processKeyOf(n) : null;
    if (k) addWithDeps(k);
  }
  return [...keys];
}

/** Daftar elemen input yang disarankan di panel kiri. */
export const INPUT_PRESETS: { label: string; hint: string; values?: boolean }[] = [
  { label: "Struktur & jabatan organisasi", hint: "Daftar jabatan, wewenang, hubungan kerja (untuk stakeholder internal)" },
  { label: "Pihak eksternal", hint: "Lembaga/pihak di luar organisasi dan hubungannya (untuk stakeholder eksternal)" },
  { label: "Notulensi rapat", hint: "Hasil rapat, evaluasi, keputusan" },
  { label: "LPJ / laporan kegiatan", hint: "Program kerja berjalan, kendala, anggaran" },
  { label: "Survei anggota", hint: "Kepuasan, minat, keluhan, survei keterlibatan" },
  { label: "Kondisi eksternal", hint: "Kebijakan kampus, aturan, hubungan dengan pihak luar, tren" },
  { label: "Penilaian stakeholder", hint: "Rating 1–4 tiap jabatan untuk faktor S/W/O/T (untuk IFAS/EFAS)" },
  { label: "Nilai organisasi (AD/ART)", hint: "Dipakai untuk visi, misi, dan cascading", values: true },
  { label: "Dokumen lain", hint: "Dokumen pendukung apa pun" },
];

/**
 * Templat alur mengikuti tab Excel framework:
 * ES (stakeholder, faktor, IFAS, EFAS) → SGS (posisi, SWOT, QSPM, cascading) → SI (kontinuitas proker) → LTV (renstra)
 * → MSDM (attraction … separation) → DM-CRM (decision, change, risk) → dokumen grand design.
 * "mvp" = hanya ES + SGS. Validator setelah matriks SWOT dan QSPM; tinjauan manusia setelah cascading.
 */
export function templateGraph(kind: "mvp" | "full" = "full"): WorkflowGraph {
  const P: [NodeKey, number, number][] = [
    ["stakeholder_internal", 300, 0],
    ["stakeholder_eksternal", 300, 150],
    ["faktor_internal", 300, 330],
    ["faktor_eksternal", 300, 500],
    ["ifas", 580, 120],
    ["efas", 580, 400],
    ["posisi_organisasi", 840, 260],
    ["swot_matrix", 1100, 260],
    ["qspm", 1360, 260],
    ["cascading", 1620, 260],
    ["kontinuitas_proker", 1880, 100],
    ["renstra", 1880, 330],
    ["msdm_attraction", 2160, -120],
    ["msdm_recruitment", 2160, 10],
    ["msdm_onboarding", 2160, 140],
    ["msdm_development", 2160, 270],
    ["msdm_penilaian", 2160, 400],
    ["msdm_retention", 2160, 530],
    ["msdm_separation", 2160, 660],
    ["decision_making", 2440, 120],
    ["change_management", 2440, 280],
    ["risk_management", 2440, 440],
  ];
  const procs = P.filter(([k]) => kind === "full" || NODES[k].phase === 1);
  const keys = new Set<string>(procs.map(([k]) => k));
  const inputDefs: { label: string; to: NodeKey[] }[] = [
    { label: "Struktur & jabatan organisasi", to: ["stakeholder_internal"] },
    { label: "Pihak eksternal", to: ["stakeholder_eksternal"] },
    { label: "Notulensi rapat", to: ["faktor_internal"] },
    { label: "LPJ / laporan kegiatan", to: ["faktor_internal", "kontinuitas_proker"] },
    { label: "Survei anggota", to: ["faktor_internal", "msdm_separation"] },
    { label: "Kondisi eksternal", to: ["faktor_eksternal"] },
    { label: "Penilaian stakeholder", to: ["ifas", "efas"] },
    { label: "Nilai organisasi (AD/ART)", to: ["cascading"] },
  ];
  const inputs: GraphNode[] = inputDefs.map((d, i) => ({
    id: `in-${i + 1}`,
    type: "input" as const,
    label: d.label,
    values: INPUT_PRESETS.find((p) => p.label === d.label)?.values,
    position: { x: 0, y: -60 + i * 110 },
  }));
  const checks: GraphNode[] = [
    { id: "val-swot", type: "validator", label: "Validator SWOT", position: { x: 1110, y: 400 } },
    { id: "val-qspm", type: "validator", label: "Validator QSPM", position: { x: 1370, y: 400 } },
    { id: "rev-cascading", type: "review", label: "Tinjau visi–misi", position: { x: 1630, y: 400 } },
  ];
  const nodes: GraphNode[] = [
    ...inputs,
    ...procs.map(([k, x, y]) => ({ id: k, type: "process" as const, key: k, position: { x, y } })),
    ...checks,
    {
      id: "out-1",
      type: "output",
      label: kind === "full" ? "Dokumen grand design" : "Laporan analisis",
      position: { x: kind === "full" ? 2720 : 1880, y: 280 },
    },
  ];
  // Panah alur (selain dependensi wajib) — dibaca sebagai "hasil ini dipakai langkah berikutnya".
  const flow: [NodeKey, NodeKey][] = [
    ["posisi_organisasi", "swot_matrix"],
    ["cascading", "kontinuitas_proker"],
    ["kontinuitas_proker", "renstra"],
    ["renstra", "msdm_attraction"],
    ["msdm_attraction", "msdm_recruitment"],
    ["msdm_recruitment", "msdm_onboarding"],
    ["msdm_onboarding", "msdm_development"],
    ["msdm_development", "msdm_penilaian"],
    ["msdm_penilaian", "msdm_retention"],
    ["msdm_retention", "msdm_separation"],
    ["msdm_separation", "decision_making"],
    ["decision_making", "change_management"],
    ["change_management", "risk_management"],
  ];
  const edges = [
    ...inputs.flatMap((n, i) => inputDefs[i].to.filter((t) => keys.has(t)).map((t) => ({ from: n.id, to: t }))),
    ...procs.flatMap(([k]) => NODES[k].deps.filter((d) => keys.has(d)).map((d) => ({ from: d, to: k }))),
    ...flow.filter(([a, b]) => keys.has(a) && keys.has(b)).map(([a, b]) => ({ from: a, to: b })),
    { from: "swot_matrix", to: "val-swot" },
    { from: "qspm", to: "val-qspm" },
    { from: "cascading", to: "rev-cascading" },
    { from: kind === "full" ? "risk_management" : "rev-cascading", to: "out-1" },
  ];
  // Panah alur yang sama dengan dependensi wajib (mis. decision → change) hanya digambar sekali.
  const uniq = edges.filter((e, i) => edges.findIndex((x) => x.from === e.from && x.to === e.to) === i);
  // Input yang tidak tersambung ke analisis mana pun (mis. di templat ringkas) tidak ditampilkan.
  const used = new Set(uniq.map((e) => e.from));
  return { nodes: nodes.filter((n) => n.type !== "input" || used.has(n.id)), edges: uniq };
}
