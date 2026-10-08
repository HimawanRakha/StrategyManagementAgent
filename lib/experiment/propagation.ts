// Model propagasi galat:  e_i' = e_i (1 − x_i d_i r_i)(1 − y_i d^h),   P = Π (1 − e_i')

export type Stage = { key: string; e: number; dr: number; cTok: number; cMin: number };
export type Choice = { validator: boolean; human: boolean };

export function effectiveError(s: Stage, c: Choice, dh: number) {
  return s.e * (c.validator ? 1 - s.dr : 1) * (c.human ? 1 - dh : 1);
}

export function predictP(stages: Stage[], place: Record<string, Choice>, dh: number) {
  return stages.reduce((p, s) => {
    const c = place[s.key] ?? { validator: false, human: false };
    return p * (1 - effectiveError(s, c, dh));
  }, 1);
}

/** Model dengan pemulihan: P_i = P_{i−1}(1 − e_i') + (1 − P_{i−1}) h_i ; sama dengan predictP bila semua h = 0. */
export function predictMarkov(stages: (Stage & { h: number })[], place: Record<string, Choice>, dh: number) {
  let p = 1;
  for (const s of stages) {
    const c = place[s.key] ?? { validator: false, human: false };
    const err = effectiveError(s, c, dh);
    p = p * (1 - err) + (1 - p) * s.h;
  }
  return p;
}

export function placementCost(stages: Stage[], place: Record<string, Choice>) {
  let tok = 0;
  let min = 0;
  for (const s of stages) {
    const c = place[s.key];
    if (c?.validator) tok += s.cTok;
    if (c?.human) min += s.cMin;
  }
  return { tok, min };
}
