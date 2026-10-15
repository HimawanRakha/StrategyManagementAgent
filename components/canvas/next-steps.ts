// "Saran langkah berikutnya" di Laporan run: aksi dan node baru yang disarankan, disusun deterministik dari data run,
// dokumen, dan canvas (tanpa AI). Modul murni.
import type { WorkflowGraph } from "@/lib/db/schema";
import { labelOf, processKeys } from "@/lib/engine/canvas";
import { NODE_KEYS, NODE_META, type NodeKey } from "@/lib/nodes/meta";
import { isCustomKey } from "@/lib/nodes/custom";
import type { ReportProjectData } from "./report-utils";

export type NextAction =
  | { type: "addBuiltin"; key: string }
  | { type: "addCustom"; name: string; instruction: string; prefix: string; parents: string[] }
  | { type: "select"; key: string };

export type Suggestion = {
  id: string;
  /** 1 = lakukan dulu, 2 = disarankan, 3 = pengembangan. */
  priority: 1 | 2 | 3;
  kind: "dokumen" | "ulang" | "bukti" | "analisis" | "kustom";
  title: string;
  detail: string;
  action?: NextAction;
};

/** Analisis dari framework kajian yang belum menjadi node bawaan — ditawarkan sebagai proses kustom siap pakai. */
export const FRAMEWORK_TEMPLATES: { id: string; match: RegExp; name: string; prefix: string; parents: string[]; why: string; instruction: string }[] = [
  {
    id: "hftko",
    match: /tata\s*kelola|gom|hftko|tko/i,
    name: "Analisis Tata Kelola (HFTKO/GOM)",
    prefix: "TK",
    parents: [],
    why: "Bab awal laporan kajian (Governance Operating Model) menelaah struktur, budaya & SDM, serta sistem administrasi organisasi.",
    instruction:
      "Telaah tata kerja organisasi (TKO), struktur, dan aturan organisasi. Untuk setiap aspek — (1) struktur dan kewenangan, (2) budaya dan SDM, (3) infrastruktur dan sistem administrasi — tuliskan kondisi saat ini, kesenjangan terhadap tata kelola yang baik, dan rekomendasi perbaikan yang konkret.",
  },
  {
    id: "kpi",
    match: /\bkpi\b|key performance/i,
    name: "Key Performance Indicator (KPI)",
    prefix: "KPI",
    parents: ["cascading"],
    why: "Sasaran strategis dari cascading belum punya ukuran keberhasilan; KPI membuat capaiannya bisa dipantau.",
    instruction:
      "Turunkan setiap sasaran strategis (SO) dari hasil Cascading visi–misi menjadi indikator kinerja utama. Untuk setiap KPI tuliskan: ID sasaran yang dirujuk, nama indikator, cara/rumus mengukur, target per periode kepengurusan, frekuensi pengukuran, dan penanggung jawab.",
  },
  {
    id: "okr",
    match: /\bokr\b|objective.*key result/i,
    name: "Objective & Key Results (OKR)",
    prefix: "OKR",
    parents: ["cascading"],
    why: "OKR menerjemahkan misi menjadi target terukur per periode, pelengkap KPI untuk monitoring strategi.",
    instruction:
      "Untuk setiap misi dari hasil Cascading visi–misi, rumuskan satu Objective yang menantang dan 2–4 Key Results yang terukur (angka, tenggat). Rujuk ID misi/sasaran yang diturunkan.",
  },
  {
    id: "tna",
    match: /training needs|\btna\b|kebutuhan pelatihan/i,
    name: "Training Needs Analysis (TNA)",
    prefix: "TNA",
    parents: ["msdm_development", "msdm_penilaian"],
    why: "Hasil development dan penilaian staf belum diterjemahkan menjadi kebutuhan pelatihan per jabatan.",
    instruction:
      "Petakan kebutuhan pelatihan per jabatan/kelompok pengurus berdasarkan hasil MSDM Development dan Penilaian staf: kompetensi yang dibutuhkan, kondisi saat ini, kesenjangan, metode pelatihan yang sesuai, prioritas, dan waktu pelaksanaan.",
  },
];

/** Kemiripan bukti terbaik di bawah ini dianggap lemah (pencarian vektor kosinus; kata kunci tidak dinilai). */
export const WEAK_SIMILARITY = 0.6;

export function nextSteps(graph: WorkflowGraph, data: ReportProjectData): Suggestion[] {
  const out: Suggestion[] = [];
  const keys = processKeys(graph);
  const docs = data.documents ?? [];
  const label = (k: string) => labelOf(graph, k);

  // 1. Dokumen baru yang belum ditinjau tidak dibaca analisis.
  const pending = docs.filter((d) => !d.reviewed_at);
  if (pending.length)
    out.push({
      id: "dokumen-tinjau",
      priority: 1,
      kind: "dokumen",
      title: `Tinjau dan setujui ${pending.length} dokumen baru`,
      detail: `Belum dibaca analisis sampai disetujui: ${pending.map((d) => d.filename).join(", ")}. Buka elemen input dokumennya di canvas.`,
    });

  // 2. Dokumen disetujui setelah analisis selesai → analisis itu belum memakai dokumen terbaru.
  const newest = Math.max(0, ...docs.filter((d) => d.reviewed_at).map((d) => +new Date(d.reviewed_at!)));
  const stale = keys.filter((k) => {
    const n = data.nodes[k];
    return n?.status === "done" && n.finishedAt && NODE_META[k as NodeKey]?.kind !== "code" && +new Date(n.finishedAt) < newest;
  });
  if (stale.length)
    out.push({
      id: "ulang-dokumen",
      priority: 2,
      kind: "ulang",
      title: `Jalankan ulang ${stale.length} analisis agar memakai dokumen terbaru`,
      detail: `Ada dokumen yang disetujui setelah analisis ini selesai: ${stale.map(label).join(", ")}.`,
    });

  // 3. Bukti lemah: analisis AI yang selesai dengan bukti dokumen sedikit atau kurang mirip, dan pertanyaan AI yang terbuka.
  for (const k of keys) {
    const n = data.nodes[k];
    if (n?.status !== "done" || NODE_META[k as NodeKey]?.kind === "code" || k === "grand_design") continue;
    const ev = (n.evidence ?? []).filter((e) => e.kind !== "user_answer");
    const sims = ev.map((e) => e.similarity).filter((x): x is number => typeof x === "number");
    const best = sims.length ? Math.max(...sims) : null;
    const open = data.questions.filter((q) => q.nodeKey === k && !q.answer?.trim()).length;
    // Analisis tanpa bukti dokumen sama sekali memang tidak membaca dokumen (mis. SWOT, QSPM memakai hasil analisis sebelumnya).
    const weak = ev.length > 0 && best !== null && best < WEAK_SIMILARITY;
    if (!weak && !open) continue;
    const topic = NODE_META[k as NodeKey]?.description ?? (isCustomKey(k) ? "instruksi proses kustom ini" : "analisis ini");
    out.push({
      id: `bukti-${k}`,
      priority: 2,
      kind: "bukti",
      title: `Lengkapi bukti untuk ${label(k)}`,
      detail: [
        weak ? `Bukti dokumen yang ditemukan kurang mirip dengan kebutuhan analisis (kemiripan terbaik ${best!.toFixed(2).replace(".", ",")}).` : "",
        open ? `${open} pertanyaan AI belum dijawab.` : "",
        `Unggah dokumen yang membahas: ${topic.replace(/\.$/, "")}, atau jawab pertanyaannya, lalu jalankan ulang.`,
      ]
        .filter(Boolean)
        .join(" "),
      action: { type: "select", key: k },
    });
  }

  // 4. Analisis bawaan framework yang belum ada di canvas.
  const missing = (NODE_KEYS as readonly string[]).filter((k) => k !== "grand_design" && !keys.includes(k));
  for (const k of missing)
    out.push({
      id: `analisis-${k}`,
      priority: 3,
      kind: "analisis",
      title: `Tambahkan analisis ${NODE_META[k as NodeKey].label}`,
      detail: `${NODE_META[k as NodeKey].description} Analisis ini ada di framework (tab Excel ${NODE_META[k as NodeKey].sheetName}) tetapi belum dipasang di canvas.`,
      action: { type: "addBuiltin", key: k },
    });

  // 5. Analisis framework kajian yang belum didukung node bawaan → proses kustom siap pakai.
  const customNames = keys.filter(isCustomKey).map((k) => label(k));
  for (const t of FRAMEWORK_TEMPLATES) {
    if (customNames.some((n) => t.match.test(n))) continue;
    const parents = t.parents.filter((p) => keys.includes(p));
    out.push({
      id: `kustom-${t.id}`,
      priority: 3,
      kind: "kustom",
      title: `Tambahkan proses baru: ${t.name}`,
      detail: `${t.why}${parents.length ? ` Akan membaca hasil ${parents.map(label).join(" dan ")}.` : ""}`,
      action: { type: "addCustom", name: t.name, instruction: t.instruction, prefix: t.prefix, parents },
    });
  }
  return out.sort((a, b) => a.priority - b.priority);
}
