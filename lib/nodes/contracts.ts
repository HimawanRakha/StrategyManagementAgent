// Kontrak data ANTAR-node: bentuk minimum output (setelah compute) yang dibaca node lain.
// Setiap node boleh menyimpan lebih banyak field, tetapi field di sini WAJIB ada dengan arti yang sama.
// Modul murni (aman di client).
import type { AhpPair } from "@/lib/calc/ahp";
import type { Evidence } from "./schemas";

// ---------- AHP (dipakai stakeholder & faktor) ----------

/** Satu himpunan perbandingan AHP di output mentah node. */
export type AhpSetRaw = {
  /** ID himpunan, mis. "kelompok", "KP", "S", "W", "SW". */
  id: string;
  /** Butir yang dibandingkan (ID yang sama dengan butir di output). */
  items: string[];
  /** Perbandingan segitiga atas; pasangan yang hilang dianggap sama penting. */
  pairs: AhpPair[];
};

/** Ringkasan hasil AHP satu himpunan (disimpan di output setelah compute). */
export type AhpSetComputed = {
  id: string;
  label: string;
  items: string[];
  weights: number[];
  lambdaMax: number;
  ci: number;
  ri: number;
  cr: number;
  consistent: boolean;
  missing: [string, string][];
};

// ---------- Stakeholder (ESSTAKEHOLDER INTERNAL / EKSTERNAL) ----------

/** Kelompok matriks power–interest. */
export type StakeholderGroup = "KP" | "KS" | "KI" | "M";
export const STAKEHOLDER_GROUP_LABEL: Record<StakeholderGroup, string> = {
  KP: "Manage Closely (Key Player)",
  KS: "Keep Satisfied",
  KI: "Keep Informed",
  M: "Monitor (Minimum Effort)",
};

export type StakeholderRole = {
  /** ID stabil, mis. "SI1" (internal) atau "SE1" (eksternal). */
  id: string;
  jabatan: string;
  power: "tinggi" | "rendah";
  interest: "tinggi" | "rendah";
  group: StakeholderGroup;
  /** Bobot jabatan di dalam kelompoknya (AHP; jumlah per kelompok = 1). */
  bobotJabatan: number;
  /** Bobot kelompok (AHP antarkelompok). */
  bobotKelompok: number;
  /** bobotJabatan × bobotKelompok (jumlah semua = 1). */
  bobotTotal: number;
  /** Opsional: unit yang diwakili jabatan ini dan menilai sendiri-sendiri di IFAS/EFAS (mis. 4 biro untuk "Kepala biro"). */
  units?: string[];
};

/** Satu kolom penilai di IFAS/EFAS: jabatan, atau satu unit dari jabatan yang punya `units` (bobot dibagi rata). */
export type StakeholderRater = {
  /** = id jabatan, atau "<id jabatan>-<k>" untuk unit ke-k (mis. "SI2-1"). */
  id: string;
  roleId: string;
  /** Nama jabatan atau nama unit. */
  name: string;
  group: StakeholderGroup;
  /** bobotTotal jabatan ÷ jumlah unit (Excel: E31 = E12/4). Σ semua penilai = subtotal. */
  weight: number;
};

export interface StakeholderComputed {
  scope: "internal" | "eksternal";
  roles: StakeholderRole[];
  groups: { group: StakeholderGroup; bobot: number }[];
  /** Σ bobotTotal (≈ 1). */
  subtotal: number;
  ahp: AhpSetComputed[];
  /** Penilai IFAS/EFAS, urut KP → KS → KI → M lalu urutan jabatan. */
  raters: StakeholderRater[];
}

// ---------- Faktor S+W / O+T (ESS+W, ESO+T) ----------

export type Quadrant = "S" | "W" | "O" | "T";

export type FactorComputed = {
  /** "S1", "W3", "O2", "T5" — nomor urut per kuadran. */
  id: string;
  quadrant: Quadrant;
  /** Kategori: 7S (Strategy, Structure, System, Staff, Style, Skill, Shared Value) atau lingkungan (Politic, Relation, Legal, …). */
  category: string;
  text: string;
  /** Bobot global (AHP; jumlah semua faktor di node ini = 1). */
  bobot: number;
  evidence: Evidence[];
};

export interface FaktorComputed {
  scope: "internal" | "eksternal";
  factors: FactorComputed[];
  /** Σ bobot (≈ 1). */
  total: number;
  ahp: AhpSetComputed[];
}

// ---------- IFAS / EFAS (ESIFAS, ESEFAS) ----------

export type FactorScoreRow = {
  id: string;
  quadrant: Quadrant;
  text: string;
  bobot: number;
  /** Rating rata-rata tertimbang per kelompok stakeholder (KP, KS, KI, M) — rumus Excel SUMPRODUCT/U. */
  kp: number;
  ks: number;
  ki: number;
  m: number;
  totalRating: number;
  /** totalRating × bobot; NEGATIF untuk W dan T (seperti Excel). */
  score: number;
};

export interface MatrixScoreComputed {
  scope: "internal" | "eksternal";
  rows: FactorScoreRow[];
  /** Σ skor (IFAS: S − W; EFAS: O − T). */
  total: number;
  /** Σ skor positif (S atau O) dan Σ |skor negatif| (W atau T). */
  totalPositive: number;
  totalNegative: number;
}

// ---------- Posisi organisasi (SGSOP) ----------

export type Kuadran = "I" | "II" | "III" | "IV";
export interface PosisiComputed {
  /** Sumbu X = total IFAS (S − W), sumbu Y = total EFAS (O − T). */
  x: number;
  y: number;
  kuadran: Kuadran;
  /** I Agresif (SO), II Diversifikasi (ST), III Turnaround (WO), IV Defensif (WT). */
  strategi: string;
  fokus: "SO" | "ST" | "WO" | "WT";
}

// ---------- SWOT matrix (SGSSWOT-SM) ----------

export type StrategyType = "SO" | "WO" | "ST" | "WT";
export type Strategy = {
  /** "SO1", "WT2". */
  id: string;
  type: StrategyType;
  /** ID faktor yang digabung, mis. ["S1","S2","O1"]. */
  factorRefs: string[];
  text: string;
};
export interface SwotMatrixComputed {
  strategies: Strategy[];
}

// ---------- QSPM (SGS-QSPM) ----------

export interface QspmComputedV2 {
  /** Semua strategi alternatif dengan total TAS dan peringkat (1 = paling menarik). */
  ranking: { id: string; type: StrategyType; text: string; tas: number; rank: number }[];
}

// ---------- Cascading (SGSCASCADING) ----------

export type Initiative = { id: string; text: string; strategyRef: string | null };
export type Objective = { id: string; text: string; initiatives: Initiative[] };
export type VisionAspect = { id: string; aspek: string; misi: string; objectives: Objective[] };
export interface CascadingComputed {
  visi: string;
  aspects: VisionAspect[];
}

// ---------- Kontinuitas proker (SIKONTINUITAS PROKER) ----------

export type ProkerStrategy = "Eliminate" | "Combine" | "Substitute" | "Improve & Continue" | "Keep it & Continue";
export interface KontinuitasComputed {
  proker: {
    id: string;
    name: string;
    effort: number;
    impact: number;
    effortLevel: "Low Effort" | "High Effort";
    impactLevel: "Low Impact" | "High Impact";
    kuadran: string;
    rekomendasi: ProkerStrategy;
  }[];
}

// ---------- Renstra (LTVMRENSTRA) ----------

export interface RenstraComputed {
  visi: string;
  misi: string[];
  sasaranUmum: string;
  years: {
    tahun: number;
    fokus: string;
    milestones: { id: string; text: string; arah: { id: string; text: string; indikator: string; target: string }[] }[];
  }[];
}

// ---------- Decision, Change & Risk Management (DM-CRMDM, DM-CRMCM, DM-CRMRM) ----------

export interface DecisionMakingComputed {
  /** KD1… (refs = ID analisis sebelumnya), KQ1… (dariKondisi), DM1… (menangani = KD/KQ), G1… (dariKeputusan = DM). */
  kondisi: { id: string; text: string; refs: string[]; evidence: Evidence[] }[];
  konsekuensi: { id: string; text: string; dariKondisi: string[] }[];
  keputusan: { id: string; text: string; menangani: string[] }[];
  goals: { id: string; text: string; dariKeputusan: string[] }[];
  /** Influence diagram (panah yang sah saja). */
  diagram: { nodes: { id: string; jenis: "kondisi" | "konsekuensi" | "keputusan" | "goal"; level: number; label: string; text: string }[]; links: { from: string; to: string; hubungan: string }[] };
  /** Kondisi/konsekuensi yang belum ditangani keputusan mana pun. */
  belumDitangani: string[];
}

export interface ChangeManagementComputed {
  /** Selalu 8 baris urut Kotter (CM1 Increase Urgency … CM8 Make it Stick); rawIndex null = tahap belum diisi. */
  steps: { id: string; no: number; tahap: string; deskripsi: string; aksi: string; keputusanRefs: string[]; rawIndex: number | null }[];
  /** Keputusan Decision making yang belum dijalankan tahap mana pun. */
  belumDijalankan: string[];
}

export interface RiskManagementComputed {
  /** Register risiko (urut per unit kerja). score = P × I (kosong = 0), rating seperti rumus Excel. */
  rows: {
    id: string;
    unitKerja: string;
    no: number;
    jenis: "Opportunity" | "Threat";
    kategori: string;
    deskripsi: string;
    p: number | null;
    i: number | null;
    score: number;
    rating: "MINOR" | "MODERATE" | "MAJOR";
    strategi: string;
    penanganan: string;
    refs: string[];
  }[];
  counts: { total: number; MINOR: number; MODERATE: number; MAJOR: number; threat: number; opportunity: number };
}

/** Teks ringkas butir untuk prompt node lain: "ID: teks". */
export const listText = (xs: { id: string; text: string }[]) => xs.map((x) => `${x.id}: ${x.text}`).join("\n");
