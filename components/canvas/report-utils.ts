// Fungsi murni untuk panel "Laporan run": ringkasan run, daftar galat & temuan, angka model, optimasi penempatan,
// dan kesimpulan. Tidak ada pemanggilan LLM: semua teks dibangun deterministik dari data run.
import type { WorkflowGraph } from "@/lib/db/schema";
import { attachedChecks, canvasNodeOf, engineParents, labelOf, processKeys } from "@/lib/engine/canvas";
import { NODE_META, type NodeKey } from "@/lib/nodes/meta";
import { isCustomKey } from "@/lib/nodes/custom";
import { optimize, optimizeDP } from "@/lib/experiment/optimize";
import { effectiveError, placementCost, predictInterval, predictP, type Choice, type Stage } from "@/lib/experiment/propagation";
import { ASSUMED, ASSUMED_WHY, FEW_DATA_N, MIN_N_USE } from "@/lib/experiment/assumptions";

// ---------------------------------------------------------------------------------------------
// Data

/** Bagian respons GET /api/projects/[id] yang dipakai laporan (kompatibel dengan ProjectData di types.ts). */
export type ReportNode = {
  nodeRunId?: string;
  status: string;
  phase?: string | null;
  validationPassed: boolean | null;
  validatorEnabled: boolean;
  humanEnabled: boolean;
  error: string | null;
  attempts: number;
  formatFailures: number;
  startedAt: string | null;
  finishedAt: string | null;
  tokens: Record<string, number>;
  validation: {
    attempt: number;
    checkName: string;
    passed: boolean;
    detail?: { kind?: string; label?: string; failures?: { check?: string; itemId?: string; message: string }[] } | null;
  }[];
  review: { startedAt: string; endedAt: string | null; approved: boolean | null } | null;
  /** Perubahan manusia pada hasil (path sel → nilai lama/baru). */
  edits?: { path: (string | number)[]; from: unknown; to: unknown; at: string }[];
  editedAt?: string | null;
};

export type ReportProjectData = {
  runId: string | null;
  nodes: Record<string, ReportNode>;
  questions: { id: string; nodeKey: string; question: string; answer: string | null; nodeRunId?: string }[];
};

/** Respons GET /api/experiments/parameters (hanya kolom yang dipakai; NaN menjadi null setelah JSON). */
export type ParamsApi = {
  stages: {
    key: string;
    e: { p: number | null; n: number; lo?: number; hi?: number; k?: number };
    d?: { p?: number | null; n: number };
    dr: number;
    /** d×r nyata (dengan vs tanpa validator di run sungguhan); null bila datanya belum cukup. */
    drObserved?: { dr: number; nOn: number; nOff: number } | null;
    cTok: number;
    cTokN: number;
    cMin: number;
    cMinN: number;
    /** Tinjauan yang tidak dihitung karena terlalu singkat (< MIN_REVIEW_SEC detik). */
    cMinIgnored?: number;
  }[];
  dh: number;
  /** Profil parameter: model AI yang datanya dipakai. Null/0 run = belum ada data untuk model ini. */
  profile?: { model: string; runs: number; measuredAt: string | null } | null;
};

/** Kisi anggaran untuk saran anggaran otomatis ("titik siku"). */
export const BUDGET_GRID = { tok: [0, 10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000], min: [0, 5, 10, 15, 20, 25, 30] };
export const CURVE_MINUTES = [0, 5, 10, 15, 20, 30];

const finite = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
const ms = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);

// ---------------------------------------------------------------------------------------------
// Ringkasan run

export function tokenSplit(n: ReportNode | undefined) {
  const t = n?.tokens ?? {};
  const gen = t.generate ?? 0;
  const check = (t.validate ?? 0) + (t.repair ?? 0);
  const total = Object.values(t).reduce((a, b) => a + (finite(b) ? b : 0), 0);
  return { gen, check, other: Math.max(0, total - gen - check), total };
}

/** Lama kerja node (detik); null bila belum selesai. */
export function durationSec(n: ReportNode | undefined): number | null {
  if (!n?.startedAt || !n.finishedAt) return null;
  const s = (ms(n.finishedAt) - ms(n.startedAt)) / 1000;
  return finite(s) && s >= 0 ? s : null;
}

/** Lama tinjauan manusia (menit); null bila belum selesai ditinjau. */
export function reviewMinutes(n: ReportNode | undefined): number | null {
  if (!n?.review?.endedAt) return null;
  const m = (ms(n.review.endedAt) - ms(n.review.startedAt)) / 60000;
  return finite(m) && m >= 0 ? m : null;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!finite(sec)) return "–";
  const s = Math.round(sec);
  if (s < 60) return `${s} dtk`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt ${s % 60} dtk`;
  return `${Math.floor(m / 60)} jam ${m % 60} mnt`;
}

/** Kunci analisis yang ditampilkan: urutan alur dari canvas, lalu node run yang sudah tidak ada di canvas. */
export function reportKeys(graph: WorkflowGraph, data: ReportProjectData) {
  const keys = processKeys(graph);
  const extra = Object.keys(data.nodes).filter((k) => !keys.includes(k));
  return { canvasKeys: keys, rowKeys: [...keys, ...extra] };
}

export function summarize(graph: WorkflowGraph, data: ReportProjectData) {
  const { canvasKeys, rowKeys } = reportKeys(graph, data);
  const status: Record<string, number> = {};
  for (const k of canvasKeys) {
    const s = data.nodes[k]?.status ?? "none";
    status[s] = (status[s] ?? 0) + 1;
  }
  let gen = 0, check = 0, other = 0, total = 0, dur = 0, durN = 0;
  let pass = 0, fail = 0, unchecked = 0, fmtFail = 0;
  let reviews = 0, reviewsDone = 0, reviewMin = 0, reviewOpen = 0, approved = 0, rejected = 0;
  for (const k of rowKeys) {
    const n = data.nodes[k];
    if (!n) continue;
    const t = tokenSplit(n);
    gen += t.gen;
    check += t.check;
    other += t.other;
    total += t.total;
    const d = durationSec(n);
    if (d !== null) {
      dur += d;
      durN++;
    }
    if (n.validatorEnabled && n.validationPassed === true) pass++;
    else if (n.validatorEnabled && n.validationPassed === false) fail++;
    else unchecked++;
    fmtFail += n.formatFailures ?? 0;
    if (n.review) {
      reviews++;
      const m = reviewMinutes(n);
      if (m !== null) {
        reviewsDone++;
        reviewMin += m;
      } else reviewOpen++;
      if (n.review.approved === true) approved++;
      if (n.review.approved === false) rejected++;
    }
  }
  const openQuestions = data.questions.filter((q) => !q.answer?.trim()).length;
  return {
    total: canvasKeys.length,
    done: status.done ?? 0,
    status,
    tokens: { gen, check, other, total },
    duration: { sec: dur, n: durN },
    validator: { pass, fail, unchecked },
    reviews: { count: reviews, done: reviewsDone, open: reviewOpen, approved, rejected, minutes: reviewMin, avg: reviewsDone ? reviewMin / reviewsDone : null },
    openQuestions,
    formatFailures: fmtFail,
  };
}
export type RunSummary = ReturnType<typeof summarize>;

/** Nama pemeriksaan yang gagal pada percobaan terakhir. */
export function failedChecks(n: ReportNode | undefined): string[] {
  const v = n?.validation ?? [];
  if (!v.length) return [];
  const last = Math.max(...v.map((x) => x.attempt));
  return [...new Set(v.filter((x) => x.attempt === last && !x.passed).map((x) => x.checkName))];
}

/** Penjelasan nama pemeriksaan (dari metadata node bawaan; kustom memakai label validator atau nama apa adanya). */
export function checkDescription(key: string, name: string, label?: string): string | undefined {
  return NODE_META[key as NodeKey]?.checks.find((c) => c.name === name)?.description ?? label;
}

const isAhpConsistency = (name: string) => /ahp.*consist|consist.*ahp|ahp_konsist/i.test(name);

// ---------------------------------------------------------------------------------------------
// Galat & temuan

export type Severity = "berat" | "sedang" | "catatan";
export const SEVERITY_ORDER: Severity[] = ["berat", "sedang", "catatan"];
export const SEVERITY_LABEL: Record<Severity, string> = { berat: "Berat", sedang: "Perlu perhatian", catatan: "Catatan" };

export type FindingKind =
  | "gagal"
  | "cek_gagal"
  | "ahp_tidak_konsisten"
  | "diperbaiki"
  | "tinjauan_ditolak"
  | "menunggu_tinjauan"
  | "pertanyaan"
  | "usang"
  | "format"
  | "diubah"
  | "belum_jalan"
  | "berjalan";

export type Finding = {
  kind: FindingKind;
  severity: Severity;
  /** Judul dalam kalimat awam, mis. "Pemeriksaan gagal dan belum teratasi". */
  title: string;
  /** Penjelasan tambahan (mis. arti pemeriksaan). */
  detail?: string;
  /** Pesan rinci (semua ditampilkan). */
  messages: { text: string; itemId?: string }[];
  check?: { name: string; kind?: string; attempts: number };
};

export type AnalysisFindings = {
  key: string;
  label: string;
  status: string;
  findings: Finding[];
  counts: Record<Severity, number>;
};

const fmtVal = (v: unknown) => {
  if (v === null || v === undefined || v === "") return "kosong";
  if (typeof v === "number") return String(Number(v.toFixed(4))).replace(".", ",");
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `"${s.slice(0, 57)}…"` : typeof v === "string" ? `"${s}"` : s;
};

/** Waktu terakhir sebuah analisis berubah (selesai dijalankan atau diubah manusia). */
const changedAt = (n: ReportNode | undefined) => Math.max(finite(ms(n?.finishedAt)) ? ms(n?.finishedAt) : -Infinity, finite(ms(n?.editedAt)) ? ms(n?.editedAt) : -Infinity);

/** Semua temuan per analisis (urut alur), tanpa ada yang disembunyikan. */
export function collectFindings(graph: WorkflowGraph, data: ReportProjectData) {
  const { rowKeys } = reportKeys(graph, data);
  const staleBy = new Map<string, { direct: string[]; via: string[] }>();
  const groups: AnalysisFindings[] = [];

  for (const k of rowKeys) {
    const n = data.nodes[k];
    const label = labelOf(graph, k);
    const f: Finding[] = [];

    if (!n || n.status === "pending" || n.status === "none") {
      f.push({ kind: "belum_jalan", severity: "catatan", title: "Belum dijalankan", messages: [] });
    } else if (n.status === "running") {
      f.push({ kind: "berjalan", severity: "catatan", title: "Sedang berjalan", messages: [] });
    }
    if (n?.status === "failed") {
      f.push({
        kind: "gagal",
        severity: "berat",
        title: "Analisis gagal — tidak menghasilkan hasil",
        detail: "Analisis sesudahnya yang membutuhkan hasil ini juga tidak bisa berjalan. Jalankan ulang setelah penyebabnya diatasi.",
        messages: [{ text: n.error?.trim() || "Tidak ada pesan galat." }],
      });
    }

    // Pemeriksaan otomatis: percobaan terakhir menentukan galat yang masih ada; yang gagal lalu lolos = diperbaiki otomatis.
    const v = n?.validation ?? [];
    if (v.length) {
      const last = Math.max(...v.map((x) => x.attempt));
      const names = [...new Set(v.map((x) => x.checkName))];
      for (const name of names) {
        const rows = v.filter((x) => x.checkName === name);
        const lastRow = [...rows].reverse().find((x) => x.attempt === last);
        const failedRows = rows.filter((x) => !x.passed);
        const label2 = rows.find((x) => x.detail?.label)?.detail?.label;
        const desc = checkDescription(k, name, label2);
        const kind = rows.find((x) => x.detail?.kind)?.detail?.kind;
        const attempts = new Set(rows.map((x) => x.attempt)).size;
        const msgs = (row: (typeof rows)[number] | undefined) =>
          (row?.detail?.failures ?? []).map((x) => ({ text: x.message, itemId: x.itemId }));
        if (lastRow && !lastRow.passed) {
          const ahpBad = isAhpConsistency(name);
          f.push({
            kind: ahpBad ? "ahp_tidak_konsisten" : "cek_gagal",
            severity: "berat",
            title: ahpBad ? "Perbandingan AHP tidak konsisten (CR > 0,10) — belum teratasi" : `Pemeriksaan "${desc ?? name}" gagal dan belum teratasi`,
            detail: ahpBad
              ? "Penilaian berpasangan saling bertentangan, sehingga bobot kurang dapat dipercaya. Ubah perbandingan yang disebut di bawah pada sheet AHP analisis ini."
              : failedRows.length > 1
                ? `Sudah dicoba diperbaiki otomatis ${failedRows.length - 1} kali, tetapi masih gagal.`
                : undefined,
            messages: msgs(lastRow).length ? msgs(lastRow) : [{ text: "Pemeriksaan tidak lolos (tanpa rincian)." }],
            check: { name, kind, attempts },
          });
        } else if (failedRows.length) {
          f.push({
            kind: "diperbaiki",
            severity: "catatan",
            title: `Diperbaiki otomatis: "${desc ?? name}"`,
            detail: "Validator menemukan masalah ini, AI memperbaikinya, lalu pemeriksaan ulang lolos. Masalah semula:",
            messages: msgs(failedRows[0]),
            check: { name, kind, attempts },
          });
        }
      }
    } else if (n?.validatorEnabled && n.validationPassed === false) {
      f.push({ kind: "cek_gagal", severity: "berat", title: "Pemeriksaan otomatis tidak lolos (tanpa rincian)", messages: [] });
    }

    if (n?.review?.approved === false)
      f.push({
        kind: "tinjauan_ditolak",
        severity: "berat",
        title: "Ditolak peninjau manusia",
        detail: "Hasil ini dinilai belum layak oleh pengurus. Jalankan ulang dengan catatan peninjau.",
        messages: [],
      });
    if (n?.status === "needs_review")
      f.push({
        kind: "menunggu_tinjauan",
        severity: "sedang",
        title: "Menunggu tinjauan manusia",
        detail: "Hasil belum dipakai analisis berikutnya sampai disetujui.",
        messages: [],
      });

    const qs = data.questions.filter((q) => q.nodeKey === k && !q.answer?.trim());
    if (qs.length)
      f.push({
        kind: "pertanyaan",
        severity: "sedang",
        title: `${qs.length} pertanyaan AI belum dijawab`,
        detail: "AI bertanya karena data di dokumen kurang. Jawaban dipakai saat analisis dijalankan ulang.",
        messages: qs.map((q) => ({ text: q.question })),
      });

    // Usang: induk berubah (dijalankan ulang/diubah manusia) setelah analisis ini selesai, atau induknya sendiri usang.
    if (n?.finishedAt && n.status === "done") {
      const mine = ms(n.finishedAt);
      const parents = engineParents(graph, k);
      const direct = parents.filter((p) => changedAt(data.nodes[p]) > mine + 1000);
      const via = parents.filter((p) => !direct.includes(p) && staleBy.has(p));
      if (direct.length || via.length) {
        staleBy.set(k, { direct, via });
        f.push({
          kind: "usang",
          severity: "sedang",
          title: "Mungkin usang — analisis sebelumnya berubah setelah analisis ini selesai",
          detail: "Angka hitungan sudah diperbarui otomatis, tetapi teks usulan AI belum. Jalankan ulang analisis ini agar isinya sesuai data terbaru.",
          messages: [
            ...direct.map((p) => ({ text: `${labelOf(graph, p)} diubah atau dijalankan ulang sesudah analisis ini selesai.` })),
            ...via.map((p) => ({ text: `Ikut terdampak karena ${labelOf(graph, p)} juga usang.` })),
          ],
        });
      }
    }

    if (n?.formatFailures)
      f.push({
        kind: "format",
        severity: "catatan",
        title: `Jawaban AI tidak terbaca ${n.formatFailures} kali dan diminta ulang`,
        detail: "Dicatat terpisah; bukan galat isi analisis.",
        messages: [],
      });

    const edits = n?.edits ?? [];
    if (edits.length)
      f.push({
        kind: "diubah",
        severity: "catatan",
        title: `Diubah manusia: ${edits.length} perubahan`,
        detail: "Angka/teks usulan AI yang diganti pengguna (hasil hitungan sudah memakai nilai baru).",
        messages: edits.map((e) => ({ text: `${e.path.join(".")}: ${fmtVal(e.from)} → ${fmtVal(e.to)}` })),
      });

    f.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    const counts = { berat: 0, sedang: 0, catatan: 0 } as Record<Severity, number>;
    for (const x of f) counts[x.severity]++;
    groups.push({ key: k, label, status: n?.status ?? "none", findings: f, counts });
  }

  const totals = { berat: 0, sedang: 0, catatan: 0 } as Record<Severity, number>;
  for (const g of groups) for (const s of SEVERITY_ORDER) totals[s] += g.counts[s];
  const byKind = (kind: FindingKind) => groups.filter((g) => g.findings.some((x) => x.kind === kind));
  return { groups, totals, byKind };
}
export type FindingsReport = ReturnType<typeof collectFindings>;

// ---------------------------------------------------------------------------------------------
// Angka model (tidak bergantung pada penempatan saat ini)

/** Validator hanya tersedia untuk analisis yang punya pemeriksaan (semua kustom; bawaan sesuai metadata). */
export const validatorAvailable = (key: string) => isCustomKey(key) || !!NODE_META[key as NodeKey]?.hasValidator;

/** Analisis yang dioptimasi: semua analisis di canvas kecuali kompilasi grand design. */
export const optimizableKeys = (graph: WorkflowGraph) => processKeys(graph).filter((k) => k !== "grand_design");

/** Penempatan sekarang menurut elemen validator/tinjauan yang terpasang di canvas. */
export function currentPlacement(graph: WorkflowGraph, keys: string[]): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const k of keys) {
    const n = canvasNodeOf(graph, k);
    const att = n ? attachedChecks(graph, n.id) : { validator: null, review: null };
    out[k] = { validator: !!att.validator && validatorAvailable(k), human: !!att.review };
  }
  return out;
}

/** Analisis yang punya elemen validator di canvas tetapi belum punya pemeriksaan otomatis (validatornya tidak berbuat apa-apa). */
export function inertValidators(graph: WorkflowGraph, keys: string[]): string[] {
  return keys.filter((k) => {
    const n = canvasNodeOf(graph, k);
    return !!n && !!attachedChecks(graph, n.id).validator && !validatorAvailable(k);
  });
}

/** Penempatan yang dikirim ke canvas: HANYA analisis yang berubah, agar elemen lain tidak tersentuh. */
export function placementToApply(model: ModelResult): Record<string, Choice> {
  return Object.fromEntries(model.stages.filter((s) => !sameChoice(model.current[s.key], model.rec[s.key])).map((s) => [s.key, model.rec[s.key]]));
}

export type Field = "e" | "dr" | "cTok" | "cMin";
export const FIELDS: Field[] = ["e", "dr", "cTok", "cMin"];

/** Arti setiap angka model dalam bahasa awam. */
export const FIELD_INFO: Record<Field, { sym: string; name: string; meaning: string; unit?: string }> = {
  e: { sym: "e", name: "Peluang AI keliru", meaning: "peluang hasil analisis ini keliru bila tidak diperiksa sama sekali (0–1)" },
  dr: { sym: "dʳ", name: "Daya validator", meaning: "peluang validator menemukan kekeliruan lalu berhasil memperbaikinya (0–1)" },
  cTok: { sym: "c_tok", name: "Token validator", meaning: "token AI tambahan bila validator dipasang di analisis ini", unit: "token" },
  cMin: { sym: "c_min", name: "Menit tinjauan", meaning: "menit pengurus bila tinjauan manusia dipasang di analisis ini", unit: "menit" },
};

export type Source =
  | {
      kind: "terukur";
      n: number;
      /** Rentang Wilson 95% (untuk peluang). */
      lo?: number;
      hi?: number;
      /** Asal d×r: dari run sungguhan atau dari uji sisip. */
      via?: "nyata" | "uji sisip";
      /** e = 0 dengan data sedikit: belum membuktikan tidak pernah keliru. */
      few?: boolean;
      /** Keterangan tambahan singkat. */
      note?: string;
    }
  | {
      kind: "asumsi";
      why: string;
      fewN?: number;
      /** Mengapa belum terukur, dalam kalimat pendek (mis. "baru 2 data, perlu ≥ 3"). */
      reason?: string;
    }
  | { kind: "pengaturan" }
  | { kind: "tidak ada" };
export type StageParam = { value: number; src: Source; /** k keliru dari n (untuk rentang keyakinan P) */ kn?: { k: number; n: number } };
export type StageDefault = Record<Field, StageParam>;

/**
 * Nilai awal angka model untuk satu analisis: (1) terukur dari eksperimen bila datanya cukup (n ≥ MIN_N_USE), selain itu
 * (2) asumsi tetap yang terdokumentasi. d×r memakai urutan: nyata (run sungguhan) → uji sisip → asumsi. TIDAK memakai angka run ini dan TIDAK bergantung pada penempatan di canvas,
 * sehingga rekomendasi tidak berubah hanya karena validator/tinjauan dipasang atau dilepas.
 */
export function stageDefault(key: string, params: ParamsApi | null): StageDefault {
  const m = params?.stages.find((s) => s.key === key);
  const isCode = NODE_META[key as NodeKey]?.kind === "code";
  const hasVal = validatorAvailable(key);
  const assumed = (value: number, why: string, fewN?: number, reason?: string): StageParam => ({
    value,
    src: { kind: "asumsi", why, ...(fewN ? { fewN } : {}), ...(reason ? { reason } : {}) },
  });
  const notYet = (n: number | undefined, need: number, none: string) => (n ? `baru ${n} data, perlu ≥ ${need}` : none);

  const e: StageParam =
    m && m.e.n >= MIN_N_USE && finite(m.e.p)
      ? {
          value: m.e.p,
          src: { kind: "terukur", n: m.e.n, lo: m.e.lo, hi: m.e.hi, ...(m.e.p === 0 && m.e.n < FEW_DATA_N ? { few: true } : {}) },
          kn: { k: m.e.k ?? Math.round(m.e.p * m.e.n), n: m.e.n },
        }
      : assumed(isCode ? ASSUMED.eCode : ASSUMED.e, isCode ? ASSUMED_WHY.eCode : ASSUMED_WHY.e, m?.e.n || undefined, notYet(m?.e.n, MIN_N_USE, "belum ada run yang dinilai"));

  const dN = m?.d?.n ?? 0;
  const obs = m?.drObserved;
  const dr: StageParam = !hasVal
    ? { value: 0, src: { kind: "tidak ada" } }
    : obs && finite(obs.dr)
      ? { value: obs.dr, src: { kind: "terukur", n: obs.nOn + obs.nOff, via: "nyata" } }
      : m && dN >= MIN_N_USE && finite(m.dr)
        ? { value: m.dr, src: { kind: "terukur", n: dN, via: "uji sisip" } }
        : assumed(
            ASSUMED.dr,
            ASSUMED_WHY.dr,
            dN || undefined,
            // Validator yang sudah dipasang belum tentu terukur dayanya: perlu kesalahan untuk ditangkap.
            `${m?.cTokN ? `validator sudah dipasang di ${m.cTokN} run, tetapi kesalahannya terlalu jarang untuk mengukur daya tangkapnya; ` : ""}${dN ? `uji sisip baru ${dN}, perlu ≥ ${MIN_N_USE}` : "belum diuji sisip"}`,
          );

  const cTok: StageParam = !hasVal
    ? { value: 0, src: { kind: "tidak ada" } }
    : m && m.cTokN > 0 && finite(m.cTok)
      ? { value: m.cTok, src: { kind: "terukur", n: m.cTokN, ...(m.cTok === 0 ? { note: "diperiksa program, tanpa token AI" } : {}) } }
      : assumed(ASSUMED.cTok, ASSUMED_WHY.cTok, undefined, "validator belum pernah dipasang");

  const cMin: StageParam =
    m && m.cMinN > 0 && finite(m.cMin) && m.cMin > 0
      ? { value: Number(m.cMin.toFixed(1)), src: { kind: "terukur", n: m.cMinN } }
      : assumed(
          ASSUMED.cMin,
          ASSUMED_WHY.cMin,
          undefined,
          m?.cMinIgnored ? `${m.cMinIgnored} tinjauan < 30 dtk tidak dihitung` : "belum ada tinjauan manusia",
        );

  return { e, dr, cTok, cMin };
}

/** Ketelitian peninjau manusia d^h: dari pengaturan eksperimen bila termuat, selain itu asumsi. */
export function dhDefault(params: ParamsApi | null): StageParam {
  return params && finite(params.dh) ? { value: params.dh, src: { kind: "pengaturan" } } : { value: ASSUMED.dh, src: { kind: "asumsi", why: ASSUMED_WHY.dh } };
}

/** Angka yang TERAMATI di run ini (informasi; dipakai model hanya bila pengguna menekan "Pakai angka teramati"). */
export function observedOfRun(n: ReportNode | undefined): { cTok: number | null; cMin: number | null } {
  const tok = n?.validatorEnabled ? tokenSplit(n).check : 0;
  const min = reviewMinutes(n);
  return { cTok: tok > 0 ? tok : null, cMin: min !== null && min > 0 ? Number(min.toFixed(1)) : null };
}

/** Teks yang diketik pengguna per analisis per angka (disimpan per proyek). */
export type ParamEdits = Record<string, Partial<Record<Field, string>>>;

/** Angka dari input teks; koma desimal diterima. */
export function parseNumber(s: string): number {
  const t = s.trim().replace(",", ".");
  if (!t) return NaN;
  return Number(t);
}

export const showNum = (x: number, d = 3) => String(Number(x.toFixed(d))).replace(".", ",");

/** Nilai sel angka model: teks yang diketik (bila ada) atau nilai awal; `bad` bila tidak valid. */
export function cellOf(def: StageDefault, edits: ParamEdits, k: string, f: Field) {
  const d = def[f];
  const txt = edits[k]?.[f];
  if (txt === undefined) return { text: f === "cTok" ? String(Math.round(d.value)) : showNum(d.value), value: d.value, bad: false, edited: false };
  const v = parseNumber(txt);
  const ok = Number.isFinite(v) && v >= 0 && (f === "cTok" || f === "cMin" || v <= 1);
  return { text: txt, value: ok ? v : d.value, bad: !ok, edited: true };
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Tahap model untuk rentang keyakinan: k keliru dari n ikut bila e terukur dan tidak diubah pengguna. */
export type StageKN = Stage & { k?: number; n?: number };

/** Tahap model dari nilai awal + edit pengguna. */
export function buildStages(keys: string[], defaults: Record<string, StageDefault>, edits: ParamEdits): StageKN[] {
  return keys.map((k) => {
    const hasVal = validatorAvailable(k);
    const kn = edits[k]?.e === undefined ? defaults[k].e.kn : undefined;
    return {
      ...(kn ? { k: kn.k, n: kn.n } : {}),
      key: k,
      e: clamp01(cellOf(defaults[k], edits, k, "e").value),
      dr: hasVal ? clamp01(cellOf(defaults[k], edits, k, "dr").value) : 0,
      cTok: hasVal ? cellOf(defaults[k], edits, k, "cTok").value : 0,
      cMin: cellOf(defaults[k], edits, k, "cMin").value,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Penyimpanan pengaturan per proyek (localStorage; gagal diam-diam bila tidak tersedia)

/** bTok/bMin null = pakai anggaran yang disarankan (titik siku). */
export type SavedSettings = { v: 1; edits: ParamEdits; dh: string | null; bTok: string | null; bMin: string | null };
/** Anggaran bawaan lama yang tidak pernah diubah pengguna — dianggap "pakai saran". */
const OLD_DEFAULTS = { bTok: "3000", bMin: "10" };
export const settingsKey = (projectId: string) => `strategi-agen.laporan.${projectId}`;

export function loadSettings(projectId: string): SavedSettings | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(settingsKey(projectId));
    if (!raw) return null;
    const x = JSON.parse(raw) as Partial<SavedSettings>;
    if (x?.v !== 1 || typeof x.edits !== "object" || !x.edits) return null;
    const edits: ParamEdits = {};
    for (const [k, row] of Object.entries(x.edits)) {
      if (!row || typeof row !== "object") continue;
      const clean: Partial<Record<Field, string>> = {};
      for (const f of FIELDS) if (typeof (row as Record<string, unknown>)[f] === "string") clean[f] = (row as Record<string, string>)[f];
      if (Object.keys(clean).length) edits[k] = clean;
    }
    return {
      v: 1,
      edits,
      dh: typeof x.dh === "string" ? x.dh : null,
      bTok: typeof x.bTok === "string" && !(x.bTok === OLD_DEFAULTS.bTok && x.bMin === OLD_DEFAULTS.bMin) ? x.bTok : null,
      bMin: typeof x.bMin === "string" && !(x.bTok === OLD_DEFAULTS.bTok && x.bMin === OLD_DEFAULTS.bMin) ? x.bMin : null,
    };
  } catch {
    return null;
  }
}

export function saveSettings(projectId: string, s: SavedSettings) {
  try {
    if (typeof window === "undefined") return;
    const empty = !Object.keys(s.edits).length && s.dh === null && s.bTok === null && s.bMin === null;
    if (empty) window.localStorage.removeItem(settingsKey(projectId));
    else window.localStorage.setItem(settingsKey(projectId), JSON.stringify(s));
  } catch {
    /* penyimpanan browser tidak tersedia: pengaturan hanya berlaku selama panel terbuka */
  }
}

// ---------------------------------------------------------------------------------------------
// Optimasi penempatan (deterministik)

/**
 * Penempatan terbaik dalam anggaran. ≤ 8 analisis: coba semua kombinasi (pasti optimal, seri dipecah ke pilihan termurah);
 * lebih banyak: pemrograman dinamis (token dan menit dibulatkan ke atas per satuan kecil — hasil selalu muat anggaran).
 * Tahap tanpa validator diberi biaya token tak hingga agar validator tidak pernah dipilih di sana.
 * Hasil hanya bergantung pada angka model dan anggaran — sama setiap kali dihitung.
 */
export function bestPlacement(stages: Stage[], dh: number, bTok: number, bMin: number) {
  const opt = stages.map((s) => (validatorAvailable(s.key) ? s : { ...s, dr: 0, cTok: Number.POSITIVE_INFINITY }));
  // Anggaran di atas biaya semua pemeriksaan tidak mengubah hasil; dipotong agar tabel DP kecil.
  const sumTok = opt.reduce((a, s) => a + (Number.isFinite(s.cTok) ? s.cTok : 0), 0);
  const sumMin = opt.reduce((a, s) => a + s.cMin, 0);
  const tok = Math.min(Math.max(0, bTok), sumTok);
  const min = Math.min(Math.max(0, bMin), sumMin);
  if (opt.length <= 8) {
    const r = optimize(opt, dh, tok, min);
    return { p: r.p, place: fillPlace(stages, r.place), method: "semua" as const };
  }
  const unit = Math.max(1, Math.ceil(tok / 400));
  const minUnit = Math.max(1, Math.ceil(min / 200));
  const r = optimizeDP(opt, dh, tok, min, unit, minUnit);
  const place = fillPlace(stages, r.place);
  return { p: predictP(stages, place, dh), place, method: "dp" as const };
}

function fillPlace(stages: Stage[], place: Record<string, Choice>): Record<string, Choice> {
  return Object.fromEntries(stages.map((s) => [s.key, { validator: !!place[s.key]?.validator, human: !!place[s.key]?.human }]));
}

export const sameChoice = (a: Choice | undefined, b: Choice | undefined) => !!a?.validator === !!b?.validator && !!a?.human === !!b?.human;

/** Pilihan pemeriksaan dalam kata-kata. */
export const choiceWords = (c: Choice | undefined) =>
  c?.validator && c?.human ? "validator + tinjauan manusia" : c?.validator ? "validator" : c?.human ? "tinjauan manusia" : "tanpa pemeriksaan";

/** Perubahan dari penempatan sekarang ke rekomendasi, dalam kalimat perintah. */
export function changeWords(label: string, cur: Choice | undefined, rec: Choice | undefined): string[] {
  const out: string[] = [];
  if (!cur?.validator && rec?.validator) out.push(`Tambah validator di ${label}`);
  if (cur?.validator && !rec?.validator) out.push(`Lepas validator di ${label}`);
  if (!cur?.human && rec?.human) out.push(`Tambah tinjauan manusia di ${label}`);
  if (cur?.human && !rec?.human) out.push(`Lepas tinjauan manusia di ${label}`);
  return out;
}

export type ModelResult = {
  stages: StageKN[];
  dh: number;
  current: Record<string, Choice>;
  rec: Record<string, Choice>;
  method: "semua" | "dp";
  pNone: number;
  pCur: number;
  pRec: number;
  /** Rentang keyakinan 95% (Monte Carlo atas ketidakpastian eᵢ terukur). */
  ciCur: { lo: number; hi: number };
  ciRec: { lo: number; hi: number };
  costCur: { tok: number; min: number };
  costRec: { tok: number; min: number };
  overBudget: boolean;
  /** Rekomendasi dipertahankan sama dengan penempatan sekarang karena hasil DP (dibulatkan) tidak lebih baik. */
  keptCurrent: boolean;
  curve: { minutes: number; p: number }[];
};

/** Hitung model penempatan lengkap. Deterministik untuk masukan yang sama. */
export function runModel(stages: StageKN[], dh: number, bTok: number, bMin: number, current: Record<string, Choice>): ModelResult {
  const r = bestPlacement(stages, dh, bTok, bMin);
  const costCur = placementCost(stages, current);
  const pCur = predictP(stages, current, dh);
  const curFits = costCur.tok <= bTok + 1e-9 && costCur.min <= bMin + 1e-9;
  // DP membulatkan biaya ke atas: bila penempatan sekarang muat anggaran dan lebih baik, jangan sarankan yang lebih buruk.
  const keptCurrent = r.method === "dp" && curFits && pCur > r.p + 1e-12;
  const rec = keptCurrent ? fillPlace(stages, current) : r.place;
  const pRec = keptCurrent ? pCur : r.p;
  return {
    stages,
    dh,
    current,
    rec,
    method: r.method,
    pNone: predictP(stages, {}, dh),
    pCur,
    pRec,
    ciCur: predictInterval(stages, current, dh),
    ciRec: predictInterval(stages, rec, dh),
    costCur,
    costRec: placementCost(stages, rec),
    overBudget: !curFits,
    keptCurrent,
    curve: CURVE_MINUTES.map((m) => ({ minutes: m, p: bestPlacement(stages, dh, bTok, m).p })),
  };
}

/**
 * Anggaran yang disarankan ("titik siku"): coba penempatan terbaik untuk setiap anggaran di BUDGET_GRID, lalu pilih
 * kombinasi termurah (menit dulu, lalu token) yang P-nya ≥ 95% dari P tertinggi di kisi. Biaya yang dilaporkan adalah
 * biaya penempatan sebenarnya (bisa di bawah anggaran). Deterministik.
 */
export function suggestBudget(stages: Stage[], dh: number) {
  const pts: { bTok: number; bMin: number; p: number; tok: number; min: number }[] = [];
  for (const t of BUDGET_GRID.tok)
    for (const m of BUDGET_GRID.min) {
      const r = bestPlacement(stages, dh, t, m);
      const c = placementCost(stages, r.place);
      pts.push({ bTok: t, bMin: m, p: r.p, tok: c.tok, min: c.min });
    }
  const pMax = Math.max(...pts.map((x) => x.p));
  const best = pts.filter((x) => x.p >= 0.95 * pMax - 1e-12).sort((a, b) => a.min - b.min || a.tok - b.tok || b.p - a.p)[0];
  // Anggaran = biaya sebenarnya (dibulatkan ke atas ke 1.000 token), agar saran tidak menyisakan anggaran kosong.
  return { tok: Math.ceil(best.tok / 1000) * 1000, min: Math.ceil(best.min), p: best.p, pMax };
}

/** Peluang galat sisa satu analisis dengan pilihan tertentu. */
export const residualError = (s: Stage, c: Choice | undefined, dh: number) => effectiveError(s, c ?? { validator: false, human: false }, dh);

// ---------------------------------------------------------------------------------------------
// Kesimpulan (deterministik, tanpa LLM)

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d).replace(".", ",")}%`;
const listLabels = (xs: string[], max = 6) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")}, dan ${xs.length - max} lainnya`);

export type Conclusion = {
  completeness: string;
  errors: string;
  attention: { key: string; label: string; severity: Severity; text: string }[];
  estimate: string | null;
  nextSteps: string[];
  verdict: { tone: "ok" | "warn" | "danger"; text: string };
};

export function buildConclusion(input: {
  summary: RunSummary;
  findings: FindingsReport;
  model: ModelResult | null;
  changes: string[];
  assumedCount: number;
  numberCount: number;
  labelOf: (k: string) => string;
}): Conclusion {
  const { summary: s, findings, model, changes } = input;
  const failed = s.status.failed ?? 0;
  const review = s.status.needs_review ?? 0;
  const notRun = (s.status.none ?? 0) + (s.status.pending ?? 0);
  const running = s.status.running ?? 0;

  const parts: string[] = [];
  if (failed) parts.push(`${failed} gagal`);
  if (review) parts.push(`${review} menunggu tinjauan manusia`);
  if (running) parts.push(`${running} sedang berjalan`);
  if (notRun) parts.push(`${notRun} belum dijalankan`);
  const completeness =
    s.total === 0
      ? "Belum ada analisis di canvas."
      : s.done === s.total
        ? `Lengkap: semua ${s.total} analisis sudah selesai.`
        : `${s.done} dari ${s.total} analisis selesai${parts.length ? `; ${parts.join(", ")}` : ""}. Hasil akhir belum lengkap.`;

  const repaired = findings.groups.reduce((a, g) => a + g.findings.filter((x) => x.kind === "diperbaiki").length, 0);
  const t = findings.totals;
  const unchecked = s.validator.unchecked;
  const errors =
    t.berat === 0 && t.sedang === 0
      ? `Tidak ada galat yang tersisa menurut pemeriksaan otomatis dan tinjauan${repaired ? `; ${repaired} masalah sudah diperbaiki otomatis oleh validator` : ""}.${unchecked ? ` Catatan: ${unchecked} analisis tidak diperiksa validator, jadi kekeliruannya (bila ada) tidak terlihat di laporan ini.` : ""}`
      : `Ada ${t.berat} galat berat dan ${t.sedang} hal yang perlu perhatian${repaired ? `; ${repaired} masalah lain sudah diperbaiki otomatis` : ""}.${unchecked ? ` ${unchecked} analisis tidak diperiksa validator, jadi kekeliruannya (bila ada) tidak terlihat.` : ""}`;

  const attention: Conclusion["attention"] = [];
  for (const sev of ["berat", "sedang"] as Severity[])
    for (const g of findings.groups)
      for (const x of g.findings.filter((y) => y.severity === sev))
        attention.push({ key: g.key, label: g.label, severity: sev, text: x.title + (x.messages.length ? ` (${x.messages.length} rincian)` : "") });

  let estimate: string | null = null;
  if (model && model.stages.length) {
    const diff = model.pRec - model.pCur;
    const base = `Menurut model, peluang seluruh hasil bebas galat dengan penempatan sekarang sekitar ${pct(model.pCur)} (tanpa pemeriksaan sama sekali ${pct(model.pNone)}).`;
    const rec = changes.length
      ? ` Dengan penempatan yang direkomendasikan peluangnya menjadi ${pct(model.pRec)} (${diff >= 0 ? "+" : "−"}${(Math.abs(diff) * 100).toFixed(1).replace(".", ",")} poin), dengan biaya ${Math.round(model.costRec.tok).toLocaleString("id-ID")} token pemeriksaan dan ${model.costRec.min.toFixed(1).replace(".", ",")} menit tinjauan.`
      : " Penempatan sekarang sudah yang terbaik untuk anggaran yang Anda tetapkan.";
    const caveat =
      input.assumedCount > 0
        ? ` ${input.assumedCount} dari ${input.numberCount} angka model masih asumsi, jadi perkiraan ini kasar.`
        : " Semua angka model terukur dari eksperimen.";
    estimate = `${base}${rec}${caveat} Perkiraan ini memakai angka rata-rata, bukan hasil pemeriksaan run ini — galat yang sudah terlihat di atas tetap harus diperbaiki.`;
  }

  const L = (kind: FindingKind) => findings.byKind(kind).map((g) => g.label);
  const steps: string[] = [];
  if (L("gagal").length) steps.push(`Atasi penyebab galat lalu jalankan ulang analisis yang gagal: ${listLabels(L("gagal"))}.`);
  if (L("ahp_tidak_konsisten").length)
    steps.push(`Perbaiki perbandingan AHP yang tidak konsisten (lihat saran pasangan di bagian Galat) di: ${listLabels(L("ahp_tidak_konsisten"))}.`);
  if (L("cek_gagal").length) steps.push(`Perbaiki butir yang ditolak pemeriksaan otomatis (ubah sel atau jalankan ulang) di: ${listLabels(L("cek_gagal"))}.`);
  if (L("tinjauan_ditolak").length) steps.push(`Jalankan ulang analisis yang ditolak peninjau: ${listLabels(L("tinjauan_ditolak"))}.`);
  if (L("menunggu_tinjauan").length) steps.push(`Selesaikan tinjauan manusia di: ${listLabels(L("menunggu_tinjauan"))}.`);
  if (L("pertanyaan").length) steps.push(`Jawab pertanyaan AI di: ${listLabels(L("pertanyaan"))}, lalu jalankan ulang analisis tersebut.`);
  if (L("usang").length) steps.push(`Jalankan ulang analisis yang mungkin usang agar teksnya sesuai data terbaru: ${listLabels(L("usang"))}.`);
  if (notRun) steps.push(`Jalankan ${notRun} analisis yang belum dijalankan.`);
  if (changes.length) steps.push(`Pertimbangkan menerapkan rekomendasi penempatan: ${changes.join("; ")}.`);
  if (input.assumedCount > 0) steps.push("Ukur angka sungguhan di menu Eksperimen agar rekomendasi lebih tepat.");
  if (!steps.length) steps.push("Hasil siap dipakai sebagai draf. Tetap baca ulang sebelum diputuskan bersama pengurus.");

  const verdict: Conclusion["verdict"] =
    s.total === 0
      ? { tone: "warn", text: "Belum ada yang bisa disimpulkan." }
      : t.berat > 0 || failed > 0
        ? { tone: "danger", text: "Belum layak dipakai: masih ada galat berat yang harus diperbaiki." }
        : t.sedang > 0 || s.done < s.total
          ? { tone: "warn", text: "Hampir siap: selesaikan hal yang perlu perhatian di bawah." }
          : { tone: "ok", text: "Siap dipakai sebagai draf: tidak ada galat yang tersisa menurut pemeriksaan." };

  return { completeness, errors, attention, estimate, nextSteps: steps, verdict };
}

// ---------------------------------------------------------------------------------------------
// Beberapa run sekaligus (mis. 5 run eksperimen bertag sama): rata-rata ringkasan & gabungan temuan

/** Rata-rata ringkasan per run (angka bisa pecahan, mis. 0,8 tinjauan per run). */
export function averageSummaries(list: RunSummary[]): RunSummary {
  if (list.length === 1) return list[0];
  const n = list.length || 1;
  const avg = (f: (s: RunSummary) => number) => list.reduce((a, s) => a + f(s), 0) / n;
  const statusKeys = [...new Set(list.flatMap((s) => Object.keys(s.status)))];
  const reviewsDone = avg((s) => s.reviews.done);
  const reviewMin = avg((s) => s.reviews.minutes);
  return {
    total: avg((s) => s.total),
    done: avg((s) => s.done),
    status: Object.fromEntries(statusKeys.map((k) => [k, avg((s) => s.status[k] ?? 0)])),
    tokens: { gen: avg((s) => s.tokens.gen), check: avg((s) => s.tokens.check), other: avg((s) => s.tokens.other), total: avg((s) => s.tokens.total) },
    duration: { sec: avg((s) => s.duration.sec), n: avg((s) => s.duration.n) },
    validator: { pass: avg((s) => s.validator.pass), fail: avg((s) => s.validator.fail), unchecked: avg((s) => s.validator.unchecked) },
    reviews: {
      count: avg((s) => s.reviews.count),
      done: reviewsDone,
      open: avg((s) => s.reviews.open),
      approved: avg((s) => s.reviews.approved),
      rejected: avg((s) => s.reviews.rejected),
      minutes: reviewMin,
      avg: reviewsDone ? reviewMin / reviewsDone : null,
    },
    openQuestions: avg((s) => s.openQuestions),
    formatFailures: avg((s) => s.formatFailures),
  };
}

/** Gabungkan temuan beberapa run per analisis; judul setiap temuan diberi nama run-nya agar tidak ada yang tersembunyi. */
export function mergeFindings(list: FindingsReport[], runLabels: string[]): FindingsReport {
  if (list.length === 1) return list[0];
  const byKey = new Map<string, AnalysisFindings>();
  list.forEach((rep, i) => {
    for (const g of rep.groups) {
      const cur = byKey.get(g.key) ?? { key: g.key, label: g.label, status: g.status, findings: [], counts: { berat: 0, sedang: 0, catatan: 0 } };
      // Status gabungan: yang paling bermasalah (gagal > menunggu > berjalan > belum > selesai).
      const rank = (s: string) => ["failed", "needs_review", "running", "pending", "none", "done"].indexOf(s);
      if (rank(g.status) >= 0 && (rank(cur.status) < 0 || rank(g.status) < rank(cur.status))) cur.status = g.status;
      for (const f of g.findings) {
        cur.findings.push({ ...f, title: `${runLabels[i]} · ${f.title}` });
        cur.counts[f.severity]++;
      }
      byKey.set(g.key, cur);
    }
  });
  const groups = [...byKey.values()].map((g) => ({ ...g, findings: [...g.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)) }));
  const totals = { berat: 0, sedang: 0, catatan: 0 } as Record<Severity, number>;
  for (const g of groups) for (const s of SEVERITY_ORDER) totals[s] += g.counts[s];
  const byKind = (kind: FindingKind) => groups.filter((g) => g.findings.some((x) => x.kind === kind));
  return { groups, totals, byKind };
}
