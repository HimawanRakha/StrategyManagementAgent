// Migrasi canvas "BEM FTEIC ITS" dari node bawaan lama (audit, SWOT, IFAS/EFAS, TOWS, …) ke node baru per tab Excel.
// Dipertahankan: semua node input (ID sama → dokumen tetap terhubung) dan node kustom LATAR BELAKANG, KONDISI IDEAL
// ORGANISASI, GAP ANALYSIS (ID sama → spesifikasi kustom tetap). STAKEHOLDER MAPPING kustom digantikan node bawaan
// stakeholder internal/eksternal. Modul murni (diuji di tests/bem-migrate.test.ts).
import type { GraphNode, WorkflowGraph } from "@/lib/db/schema";
import { NODE_KEYS, NODES, type NodeKey } from "@/lib/nodes/registry";

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

/** Canvas masih memakai node bawaan lama? */
export function hasLegacyNodes(g: WorkflowGraph): boolean {
  return g.nodes.some((n) => n.type === "process" && !n.custom && n.key !== "custom" && n.key && !(NODE_KEYS as readonly string[]).includes(n.key));
}

const POS: Record<NodeKey, [number, number]> = {
  stakeholder_internal: [300, 0],
  stakeholder_eksternal: [300, 150],
  faktor_internal: [300, 400],
  faktor_eksternal: [300, 600],
  ifas: [580, 200],
  efas: [580, 500],
  posisi_organisasi: [840, 350],
  swot_matrix: [1100, 350],
  qspm: [1360, 350],
  cascading: [1620, 350],
  kontinuitas_proker: [1880, 180],
  renstra: [1880, 420],
  msdm_attraction: [2160, -40],
  msdm_recruitment: [2160, 90],
  msdm_onboarding: [2160, 220],
  msdm_development: [2160, 350],
  msdm_penilaian: [2160, 480],
  msdm_retention: [2160, 610],
  msdm_separation: [2160, 740],
  decision_making: [2440, 200],
  change_management: [2440, 360],
  risk_management: [2440, 520],
  grand_design: [0, 0],
};

/** Posisi node input menurut label (kolom kiri). */
const INPUT_POS: Record<string, [number, number]> = {
  keresahan: [-280, -220],
  ambisi: [-280, -120],
  harapan: [-280, -20],
  "struktur & jabatan organisasi": [-280, 110],
  "pihak eksternal": [-280, 210],
  "notulensi rapat": [-280, 330],
  "lpj / laporan kegiatan": [-280, 430],
  "survei anggota": [-280, 530],
  "kondisi eksternal": [-280, 640],
  "jaras validasi": [-280, 760],
  "nilai organisasi (ad/art)": [600, -300],
  "jurnal/referensi": [600, -190],
};

/** Ke mana dokumen input dibaca (label input → analisis). */
const INPUT_TO: Record<string, string[]> = {
  keresahan: ["LATAR BELAKANG"],
  ambisi: ["LATAR BELAKANG"],
  harapan: ["LATAR BELAKANG"],
  "struktur & jabatan organisasi": ["stakeholder_internal"],
  "pihak eksternal": ["stakeholder_eksternal"],
  "notulensi rapat": ["faktor_internal"],
  "lpj / laporan kegiatan": ["faktor_internal", "kontinuitas_proker"],
  "survei anggota": ["faktor_internal", "msdm_separation"],
  "kondisi eksternal": ["faktor_eksternal"],
  "jaras validasi": ["ifas", "efas"],
  "nilai organisasi (ad/art)": ["KONDISI IDEAL ORGANISASI", "cascading"],
  "jurnal/referensi": ["KONDISI IDEAL ORGANISASI"],
};

const CUSTOM_KEEP: Record<string, [number, number]> = {
  "latar belakang": [0, -120],
  "kondisi ideal organisasi": [840, -250],
  "gap analysis": [1100, 120],
};

/**
 * Susun canvas baru. `newInput(label)` membuat ID untuk node input yang belum ada (Struktur & jabatan, Pihak eksternal).
 */
export function migrateBemCanvas(old: WorkflowGraph, newId: () => string = () => crypto.randomUUID()): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const idOf = new Map<string, string>(); // nama (label input / nama kustom / kunci bawaan) → id node

  // 1. Input lama (ID dipertahankan) + input baru
  for (const n of old.nodes.filter((x) => x.type === "input")) {
    const pos = INPUT_POS[norm(n.label)];
    nodes.push({ ...n, position: pos ? { x: pos[0], y: pos[1] } : n.position });
    idOf.set(norm(n.label), n.id);
  }
  for (const label of ["Struktur & jabatan organisasi", "Pihak eksternal"]) {
    if (idOf.has(norm(label))) continue;
    const id = newId();
    const pos = INPUT_POS[norm(label)];
    nodes.push({ id, type: "input", label, position: { x: pos[0], y: pos[1] } });
    idOf.set(norm(label), id);
  }

  // 2. Node kustom yang dipertahankan
  for (const n of old.nodes.filter((x) => x.type === "process" && (x.custom || x.key === "custom"))) {
    const name = norm(n.custom?.name);
    const pos = CUSTOM_KEEP[name];
    if (!pos) continue; // mis. STAKEHOLDER MAPPING → digantikan node bawaan
    nodes.push({ ...n, position: { x: pos[0], y: pos[1] } });
    idOf.set(n.custom!.name.trim().toUpperCase(), n.id);
  }

  // 3. Node bawaan baru (ID = kunci)
  for (const k of NODE_KEYS) {
    if (k === "grand_design") continue;
    nodes.push({ id: k, type: "process", key: k, position: { x: POS[k][0], y: POS[k][1] } });
    idOf.set(k, k);
  }

  // 4. Output (ID lama dipertahankan bila ada)
  const oldOut = old.nodes.find((n) => n.type === "output");
  const outId = oldOut?.id ?? "out-1";
  nodes.push({ ...(oldOut ?? {}), id: outId, type: "output", label: oldOut?.label ?? "Dokumen grand design", position: { x: 2720, y: 360 } });

  // 5. Validator & tinjauan
  const checks: { id: string; type: "validator" | "review"; label: string; pos: [number, number]; from: string[] }[] = [
    { id: newId(), type: "review", label: "Tinjau latar belakang", pos: [20, 20], from: ["LATAR BELAKANG"] },
    { id: newId(), type: "review", label: "Tinjau faktor S/W/O/T", pos: [580, 700], from: ["faktor_internal", "faktor_eksternal"] },
    { id: newId(), type: "validator", label: "Validator SWOT", pos: [1110, 490], from: ["swot_matrix"] },
    { id: newId(), type: "validator", label: "Validator QSPM", pos: [1370, 490], from: ["qspm"] },
    { id: newId(), type: "review", label: "Tinjau visi–misi", pos: [1630, 490], from: ["cascading"] },
    { id: newId(), type: "validator", label: "Validator renstra", pos: [1890, 560], from: ["renstra"] },
  ];
  for (const c of checks) nodes.push({ id: c.id, type: c.type, label: c.label, position: { x: c.pos[0], y: c.pos[1] } });

  // 6. Panah
  const edges: { from: string; to: string }[] = [];
  const link = (from: string | undefined, to: string | undefined) => {
    if (from && to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to });
  };
  const id = (name: string) => idOf.get(name) ?? idOf.get(name.toUpperCase()) ?? idOf.get(norm(name));
  for (const [label, targets] of Object.entries(INPUT_TO)) for (const t of targets) link(idOf.get(label), id(t));
  // dependensi wajib
  for (const k of NODE_KEYS) for (const d of NODES[k].deps) link(id(d), id(k));
  // alur
  const flow: [string, string][] = [
    ["LATAR BELAKANG", "stakeholder_internal"],
    ["LATAR BELAKANG", "stakeholder_eksternal"],
    ["KONDISI IDEAL ORGANISASI", "GAP ANALYSIS"],
    ["faktor_internal", "GAP ANALYSIS"],
    ["faktor_eksternal", "GAP ANALYSIS"],
    ["GAP ANALYSIS", "swot_matrix"],
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
    ["change_management", "risk_management"],
    ["risk_management", outId],
  ];
  for (const [a, b] of flow) link(id(a), b === outId ? outId : id(b));
  for (const c of checks) for (const f of c.from) link(id(f), c.id);
  return { nodes, edges };
}
