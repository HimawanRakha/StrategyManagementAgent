// Kelompok node = awalan tab di Excel framework (ES, SGS, SI, LTV, MSDM, DM-CRM). Modul murni (aman di client).
import type { NodeGroup } from "./types";

export const NODE_GROUPS: { id: NodeGroup; code: string; label: string; hint: string }[] = [
  { id: "es", code: "ES", label: "Environmental Scanning", hint: "Stakeholder, faktor internal (S+W) dan eksternal (O+T), IFAS, EFAS" },
  { id: "sgs", code: "SGS", label: "Strategy Generation & Selection", hint: "Posisi organisasi, matriks SWOT, QSPM, cascading visi–misi" },
  { id: "si", code: "SI", label: "Strategy Implementation", hint: "Kontinuitas program kerja (effort–impact)" },
  { id: "ltv", code: "LTV", label: "Long-Term Vision", hint: "Renstra tiga tahun" },
  { id: "msdm", code: "MSDM", label: "Manajemen SDM", hint: "Attraction, recruitment, onboarding, development, penilaian, retention, separation" },
  { id: "dmcrm", code: "DM-CRM", label: "Decision, Change & Risk Management", hint: "Decision making, change management (Kotter), risk management" },
  { id: "output", code: "GD", label: "Grand design", hint: "Kompilasi dokumen" },
];

export const groupOf = (id: NodeGroup) => NODE_GROUPS.find((g) => g.id === id)!;
