// Daftar node bawaan (satu node per tab Excel framework) dan dependensinya. Engine dan kanvas membaca dari sini.
import type { NodeDef, NodeKey } from "./types";
import { NODE_KEYS } from "./types";
import { stakeholderInternal, stakeholderEksternal } from "./es/stakeholder";
import { faktorInternal, faktorEksternal } from "./es/faktor";
import { ifas, efas } from "./es/matrix-score";
import { posisiOrganisasi } from "./sgs/posisi";
import { swotMatrix } from "./sgs/swot-matrix";
import { qspm } from "./sgs/qspm";
import { cascading } from "./sgs/cascading";
import { kontinuitasProker } from "./si/kontinuitas";
import { renstra } from "./ltv/renstra";
import { msdmAttraction } from "./msdm/attraction";
import { msdmRecruitment } from "./msdm/recruitment";
import { msdmOnboarding } from "./msdm/onboarding";
import { msdmDevelopment } from "./msdm/development";
import { msdmPenilaian } from "./msdm/penilaian";
import { msdmRetention } from "./msdm/retention";
import { msdmSeparation } from "./msdm/separation";
import { decisionMaking } from "./dmcrm/decision";
import { changeManagement } from "./dmcrm/change";
import { riskManagement } from "./dmcrm/risk";
import { grandDesign } from "./grand-design";
import { genericCustomDef, isCustomKey } from "./custom";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tiap node punya tipe output sendiri
export const NODES: Record<NodeKey, NodeDef<any>> = {
  stakeholder_internal: stakeholderInternal,
  stakeholder_eksternal: stakeholderEksternal,
  faktor_internal: faktorInternal,
  faktor_eksternal: faktorEksternal,
  ifas,
  efas,
  posisi_organisasi: posisiOrganisasi,
  swot_matrix: swotMatrix,
  qspm,
  cascading,
  kontinuitas_proker: kontinuitasProker,
  renstra,
  msdm_attraction: msdmAttraction,
  msdm_recruitment: msdmRecruitment,
  msdm_onboarding: msdmOnboarding,
  msdm_development: msdmDevelopment,
  msdm_penilaian: msdmPenilaian,
  msdm_retention: msdmRetention,
  msdm_separation: msdmSeparation,
  decision_making: decisionMaking,
  change_management: changeManagement,
  risk_management: riskManagement,
  grand_design: grandDesign,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dipakai engine untuk node apa pun
export function getNode(key: string): NodeDef<any> {
  if (isCustomKey(key)) return genericCustomDef(key);
  const def = NODES[key as NodeKey];
  if (!def) throw new Error(`Node tidak dikenal: ${key}`);
  return def;
}

export function isNodeKey(key: string): key is NodeKey {
  return (NODE_KEYS as readonly string[]).includes(key);
}

export { NODE_KEYS };
export type { NodeKey };
