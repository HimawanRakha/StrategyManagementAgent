// ESSTAKEHOLDER INTERNAL / ESSTAKEHOLDER EKSTERNAL — pemetaan stakeholder power–interest (Mendelow) dan bobotnya.
//
// AI mengusulkan jabatan (dengan kutipan dokumen), klasifikasi power/interest (tinggi/rendah), unit penilai (opsional),
// dan perbandingan berpasangan AHP. Kode menghitung:
//   kelompok = KP (power & interest tinggi) | KS (power tinggi, interest rendah) | KI (power rendah, interest tinggi) | M
//   bobot kelompok = AHP antar-kelompok yang punya anggota; bobot jabatan = AHP antar-jabatan dalam kelompoknya (1 bila sendiri)
//   bobot total = bobot jabatan × bobot kelompok (Excel: E11 = D11*0.473), SUB TOTAL = SUM(E11:E18) = 1
//   penilai IFAS/EFAS = jabatan, atau setiap unitnya dengan bobot total ÷ jumlah unit (Excel: E31 = E12/4).
// Modul murni (aman di client).
import { z } from "zod";
import { Evidence } from "../schemas";
import { AHP_RULES, AhpSetSchema, computeAhpSet, mockAhpSet, pairList, weightsOf } from "../ahp-common";
import {
  STAKEHOLDER_GROUP_LABEL,
  type AhpSetComputed,
  type AhpSetRaw,
  type StakeholderComputed,
  type StakeholderGroup,
  type StakeholderRater,
  type StakeholderRole,
} from "../contracts";
import type { CheckResult, CheckSpec, Failure, NodeContext, NodeDef, NodeKey, SheetContext } from "../types";
import { EVIDENCE_RULES, JSON_ONLY, evidenceBlock, jsonSchemaText, orgLine } from "../prompt";
import { sentencesOf } from "../heuristics";
import { checkQuotes, llmJudge, result } from "@/lib/validators/common";
import { GridBuilder, addr, num, type Block, type FormulaDoc, type Grid } from "@/lib/sheets/grid";
import { ahpGrid, type AhpSheetSet } from "@/lib/sheets/ahp-sheet";
import {
  FILL,
  VIEW_TAG,
  ahpView,
  checkAhpViews,
  checkAhpViewsConsistency,
  normText,
  remapAhpEdits,
  similarity,
  sum,
  type AhpView,
} from "./es-common";

export type StakeholderScope = "internal" | "eksternal";

export const STAKEHOLDER_GROUPS: StakeholderGroup[] = ["KP", "KS", "KI", "M"];
/** Nama kelompok seperti di Excel (kolom "S. Mapping"). */
export const GROUP_NAME: Record<StakeholderGroup, string> = {
  KP: "Manage Closely",
  KS: "Keep Satisfied",
  KI: "Keep Informed",
  M: "Monitor",
};

/** Kelompok dari klasifikasi power–interest. */
export function groupOf(power: "tinggi" | "rendah", interest: "tinggi" | "rendah"): StakeholderGroup {
  if (power === "tinggi") return interest === "tinggi" ? "KP" : "KS";
  return interest === "tinggi" ? "KI" : "M";
}

const KEY: Record<StakeholderScope, NodeKey> = { internal: "stakeholder_internal", eksternal: "stakeholder_eksternal" };
const PREFIX: Record<StakeholderScope, string> = { internal: "SI", eksternal: "SE" };
const SHEET: Record<StakeholderScope, string> = { internal: "ESSTAKEHOLDER INTERNAL", eksternal: "ESSTAKEHOLDER EKSTERNAL" };

// ---------- Skema output mentah (AI) ----------

const splitUnits = (v: unknown) =>
  typeof v === "string"
    ? v
        .split(/[;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : v === null
      ? []
      : v;

export const StakeholderRoleRaw = z.object({
  id: z.string().min(1).describe('ID jabatan berurutan: "SI1", "SI2", … (internal) atau "SE1", "SE2", … (eksternal)'),
  jabatan: z.string().min(1).describe("Nama jabatan/pihak, BUKAN nama orang (mis. \"Sekretaris Jenderal\", \"Wakil Dekan bidang kemahasiswaan\")"),
  power: z.enum(["tinggi", "rendah"]).describe("Kemampuan memengaruhi keputusan/arah organisasi"),
  interest: z.enum(["tinggi", "rendah"]).describe("Besarnya kepentingan & keterlibatan pada program/hasil organisasi"),
  units: z
    .preprocess(splitUnits, z.array(z.string()).max(12))
    .optional()
    .describe("Opsional: nama unit bila jabatan ini mewakili beberapa unit yang menilai sendiri-sendiri (mis. 4 biro); bobot dibagi rata"),
  reason: z.string().default("").describe("Alasan singkat klasifikasi power/interest"),
  evidence: z.array(Evidence).default([]),
});

export const StakeholderOutput = z.object({
  roles: z.array(StakeholderRoleRaw),
  /** Himpunan AHP: {"id":"kelompok","items":["KP","KS","KI","M"]} dan {"id":"jabatan","items":[semua ID jabatan]}. */
  ahp: z.array(AhpSetSchema).default([]),
  /** Dugaan jabatan/pihak yang tidak didukung dokumen → pertanyaan untuk pengguna. */
  unsupported: z.array(z.string()).default([]),
});
export type StakeholderOutput = z.infer<typeof StakeholderOutput>;
type RoleRaw = StakeholderOutput["roles"][number];

// ---------- Output setelah compute ----------

export type StakeholderRoleOut = StakeholderRole & {
  /** Posisi jabatan di output mentah (untuk path edit). */
  rawIndex: number;
  reason: string;
  evidence: Evidence[];
};

export type StakeholderOut = Omit<StakeholderOutput, "roles" | "ahp"> &
  Omit<StakeholderComputed, "roles"> & {
    roles: StakeholderRoleOut[];
    /** Salinan himpunan AHP mentah (untuk sheet AHP yang bisa diedit). */
    ahpRaw: AhpSetRaw[];
  };

// ---------- Perhitungan ----------

type Views = {
  members: Record<StakeholderGroup, number[]>;
  active: StakeholderGroup[];
  kelompok: AhpView | null;
  byGroup: Partial<Record<StakeholderGroup, AhpView>>;
};

/** Tampilan AHP yang berlaku untuk klasifikasi saat ini (pasangan diambil dari himpunan mentah mana pun). */
function stakeholderViews(roles: RoleRaw[], sets: AhpSetRaw[] | undefined): Views {
  const members: Record<StakeholderGroup, number[]> = { KP: [], KS: [], KI: [], M: [] };
  roles.forEach((r, i) => members[groupOf(r.power, r.interest)].push(i));
  const active = STAKEHOLDER_GROUPS.filter((g) => members[g].length);
  const kelompok = active.length >= 2 ? ahpView(sets, "kelompok", active) : null;
  const byGroup: Views["byGroup"] = {};
  for (const g of active)
    if (members[g].length >= 2) byGroup[g] = ahpView(sets, g, [...new Set(members[g].map((i) => roles[i].id))]);
  return { members, active, kelompok, byGroup };
}

const viewLabel = (id: string) =>
  id === "kelompok" ? "antarkelompok stakeholder" : id in GROUP_NAME ? `jabatan dalam kelompok ${GROUP_NAME[id as StakeholderGroup]}` : id;

const cleanUnits = (u: string[] | undefined) => [...new Set((u ?? []).map((s) => s.trim()).filter(Boolean))];

/** Kalkulator kode: kelompok, bobot AHP, bobot total, sub total, dan daftar penilai IFAS/EFAS. */
export function computeStakeholder(out: StakeholderOutput, scope: StakeholderScope): StakeholderOut {
  const raw = out.roles ?? [];
  const v = stakeholderViews(raw, out.ahp);
  const ahpSets: AhpSetComputed[] = [];
  const gw: Record<StakeholderGroup, number> = { KP: 0, KS: 0, KI: 0, M: 0 };
  if (v.kelompok) {
    const c = computeAhpSet(v.kelompok.raw, "Antarkelompok stakeholder");
    ahpSets.push(c);
    Object.assign(gw, weightsOf(c));
  } else if (v.active.length === 1) gw[v.active[0]] = 1;
  const local = new Map<number, number>();
  for (const g of v.active) {
    const view = v.byGroup[g];
    if (view) {
      const c = computeAhpSet(view.raw, `Jabatan dalam kelompok ${GROUP_NAME[g]}`);
      ahpSets.push(c);
      const w = weightsOf(c);
      v.members[g].forEach((i) => local.set(i, w[raw[i].id] ?? 0));
    } else v.members[g].forEach((i) => local.set(i, 1));
  }
  const roles: StakeholderRoleOut[] = [];
  const raters: StakeholderRater[] = [];
  for (const g of STAKEHOLDER_GROUPS)
    for (const i of v.members[g]) {
      const r = raw[i];
      const units = cleanUnits(r.units);
      const bobotJabatan = local.get(i) ?? 0;
      const bobotTotal = bobotJabatan * gw[g];
      roles.push({
        id: r.id,
        jabatan: r.jabatan,
        power: r.power,
        interest: r.interest,
        group: g,
        bobotJabatan,
        bobotKelompok: gw[g],
        bobotTotal,
        ...(units.length ? { units } : {}),
        rawIndex: i,
        reason: r.reason ?? "",
        evidence: r.evidence ?? [],
      });
      if (units.length)
        units.forEach((u, k) => raters.push({ id: `${r.id}-${k + 1}`, roleId: r.id, name: u, group: g, weight: bobotTotal / units.length }));
      else raters.push({ id: r.id, roleId: r.id, name: r.jabatan, group: g, weight: bobotTotal });
    }
  return {
    ...out,
    scope,
    roles,
    groups: STAKEHOLDER_GROUPS.map((g) => ({ group: g, bobot: gw[g] })),
    subtotal: sum(roles.map((r) => r.bobotTotal)),
    ahp: ahpSets,
    ahpRaw: out.ahp ?? [],
    raters,
  };
}

const isComputed = (o: unknown): o is StakeholderOut =>
  !!o && typeof o === "object" && Array.isArray((o as StakeholderOut).raters) && typeof (o as StakeholderOut).subtotal === "number";

/** Output (mentah atau sudah dihitung) → bentuk hasil hitung. */
export function asStakeholder(o: unknown, scope: StakeholderScope): StakeholderOut {
  if (isComputed(o)) return o;
  const p = StakeholderOutput.safeParse(o ?? {});
  return computeStakeholder(p.success ? p.data : { roles: [], ahp: [], unsupported: [] }, scope);
}

/** Penilai IFAS/EFAS dari output stakeholder (cadangan untuk output lama tanpa `raters`). */
export function ratersOf(o: unknown): StakeholderRater[] {
  if (!o || typeof o !== "object") return [];
  const s = o as Partial<StakeholderComputed>;
  if (Array.isArray(s.raters)) return s.raters;
  if (Array.isArray(s.roles))
    return s.roles.map((r) => ({ id: r.id, roleId: r.id, name: r.jabatan, group: r.group, weight: r.bobotTotal ?? 0 }));
  return [];
}

// ---------- Sheet ----------

const quoteText = (ev: Evidence[]) => ev.map((e) => `[${e.chunkId}] "${e.quote}"`).join("\n");

function rawRolesOf(o: StakeholderOut): RoleRaw[] {
  return [...o.roles]
    .sort((a, b) => a.rawIndex - b.rawIndex)
    .map((r) => ({ id: r.id, jabatan: r.jabatan, power: r.power, interest: r.interest, units: r.units, reason: r.reason, evidence: r.evidence }));
}

export function stakeholderSheets(o: StakeholderOut, scope: StakeholderScope): Grid[] {
  const key = KEY[scope];
  const SC = scope.toUpperCase();
  const g = new GridBuilder("stakeholder", SHEET[scope], `Stakeholder ${scope} — matriks power–interest dan bobot`);
  const inGroup = (grp: StakeholderGroup) => o.roles.filter((r) => r.group === grp);
  const names = (grp: StakeholderGroup) =>
    inGroup(grp)
      .map((r) => (r.units?.length ? `${r.jabatan} (${r.units.length} unit)` : r.jabatan))
      .join("\n") || "–";
  const views = stakeholderViews(rawRolesOf(o), o.ahpRaw);
  const gwOf = Object.fromEntries(o.groups.map((x) => [x.group, x.bobot])) as Record<StakeholderGroup, number>;

  // Matriks power–interest (A1:D8 seperti Excel)
  g.set(0, 0, SC, { style: "title", cs: 4, fill: FILL.red, center: true });
  g.set(1, 0, "Power", { style: "header", rs: 4, fill: FILL.power, center: true });
  g.set(1, 1, "TINGGI", { style: "header", rs: 2, fill: FILL.level, center: true });
  g.set(3, 1, "RENDAH", { style: "header", rs: 2, fill: FILL.level, center: true });
  const quad = (r: number, c: number, grp: StakeholderGroup, hint: string) => {
    g.set(r, c, GROUP_NAME[grp], { style: "subheader", fill: FILL.quadrant, center: true, note: `${STAKEHOLDER_GROUP_LABEL[grp]}: ${hint}` });
    g.set(r + 1, c, names(grp), { style: "text", fill: FILL.names, src: "ai", note: `Jabatan dengan ${hint} (ubah power/interest di tabel bawah untuk memindahkan).` });
  };
  quad(1, 2, "KS", "power tinggi, interest rendah");
  quad(1, 3, "KP", "power tinggi, interest tinggi");
  quad(3, 2, "M", "power rendah, interest rendah");
  quad(3, 3, "KI", "power rendah, interest tinggi");
  g.set(5, 0, "Stakeholder\nMapping", { style: "header", rs: 3, cs: 2, fill: FILL.mapping, center: true });
  g.set(5, 2, "RENDAH", { style: "header", rs: 2, fill: FILL.level, center: true });
  g.set(5, 3, "TINGGI", { style: "header", rs: 2, fill: FILL.level, center: true });
  g.set(7, 2, "Interest", { style: "header", cs: 2, fill: FILL.power, center: true });

  // Tabel bobot (A9:E19 seperti Excel) + kolom tambahan yang bisa diedit
  g.set(8, 0, SC, { style: "subheader", cs: 5, center: true });
  g.row(9, 0, ["S. Mapping", "Bobot Kelompok", "Jabatan", "Bobot", "Bobot total", "Power", "Interest", "Unit penilai (opsional)", "Alasan & bukti dokumen"], {
    style: "header",
    fill: FILL.tableHead,
  });
  let r = 10;
  const first = r;
  const btAddr = new Map<string, string>();
  for (const grp of STAKEHOLDER_GROUPS) {
    const rs = inGroup(grp);
    if (!rs.length) continue;
    const start = r;
    const fill = FILL[grp];
    g.set(start, 0, GROUP_NAME[grp], { style: "label", rs: rs.length, fill, note: STAKEHOLDER_GROUP_LABEL[grp] });
    const gw = gwOf[grp] ?? 0;
    g.set(start, 1, gw, {
      rs: rs.length,
      fill,
      fmt: "0.000",
      ...(views.kelompok
        ? {
            src: "ahp" as const,
            f: `{{${key}!w_${grp}}}`,
            explain: `Bobot kelompok ${GROUP_NAME[grp]} dari AHP antarkelompok (sheet AHP) = ${num(gw)}`,
          }
        : { src: "tetap" as const, note: "Hanya satu kelompok yang punya anggota → bobot kelompok 1" }),
    });
    g.anchor(`g_${grp}`, start, 1);
    rs.forEach((role, k) => {
      const rr = start + k;
      g.set(rr, 2, role.jabatan, {
        style: "text",
        fill,
        src: "ai",
        note: role.reason || undefined,
        refs: role.evidence.map((e) => e.chunkId),
        edit: { path: ["roles", role.rawIndex, "jabatan"], type: "text" },
      });
      g.set(rr, 3, role.bobotJabatan, {
        fill,
        fmt: "0.000",
        ...(views.byGroup[grp]
          ? {
              src: "ahp" as const,
              f: `{{${key}!w_${role.id}}}`,
              explain: `Bobot ${role.jabatan} di kelompok ${GROUP_NAME[grp]} dari AHP antarjabatan (sheet AHP) = ${num(role.bobotJabatan)}`,
            }
          : { src: "tetap" as const, note: "Satu-satunya jabatan di kelompok ini → bobot 1" }),
      });
      g.set(rr, 4, role.bobotTotal, {
        fill,
        fmt: "0.0000",
        src: "hitung",
        f: `${addr(rr, 3)}*${addr(start, 1, true)}`,
        explain: `Bobot total ${role.jabatan} = bobot × bobot kelompok = ${num(role.bobotJabatan)} × ${num(gw)} = ${num(role.bobotTotal, 4)}`,
      });
      g.anchor(`bt_${role.id}`, rr, 4);
      btAddr.set(role.id, addr(rr, 4));
      g.set(rr, 5, role.power, { center: true, src: "ai", edit: { path: ["roles", role.rawIndex, "power"], type: "select", options: ["tinggi", "rendah"] } });
      g.set(rr, 6, role.interest, { center: true, src: "ai", edit: { path: ["roles", role.rawIndex, "interest"], type: "select", options: ["tinggi", "rendah"] } });
      g.set(rr, 7, role.units?.length ? role.units.join("; ") : "", {
        style: "text",
        src: "ai",
        note: "Pisahkan nama unit dengan titik koma (;). Bobot total jabatan dibagi rata ke setiap unit di IFAS/EFAS. Kosongkan bila jabatan menilai sebagai satu penilai.",
        edit: { path: ["roles", role.rawIndex, "units"], type: "text", allowEmpty: true },
      });
      g.set(rr, 8, [role.reason, quoteText(role.evidence)].filter(Boolean).join("\n"), {
        style: "muted",
        src: "dokumen",
        refs: role.evidence.map((e) => e.chunkId),
      });
    });
    r += rs.length;
  }
  g.set(r, 0, "SUB TOTAL", { style: "total", cs: 4 });
  g.set(r, 4, o.subtotal, {
    style: "total",
    fmt: "0.000",
    src: "hitung",
    f: r > first ? `SUM(E${first + 1}:E${r})` : "0",
    explain: `Sub total = jumlah bobot total semua jabatan = ${num(o.subtotal)} (harus 1)`,
  });
  g.anchor("subtotal", r, 4);

  // Penilai IFAS/EFAS (Excel: E31 = E12/4 untuk 4 biro)
  r += 2;
  g.set(r, 0, `Penilai di ${scope === "internal" ? "IFAS" : "EFAS"} (satu kolom per penilai)`, { style: "subheader", cs: 5 });
  r++;
  g.row(r, 0, ["Kode", "Penilai", "Kelompok", "Jabatan asal", "Bobot penilai"], { style: "header", fill: FILL.tableHead });
  r++;
  const r0 = r;
  for (const rt of o.raters) {
    const role = o.roles.find((x) => x.id === rt.roleId);
    const n = role?.units?.length ?? 0;
    const src = btAddr.get(rt.roleId);
    g.set(r, 0, rt.id, { style: "label" });
    g.set(r, 1, rt.name, { style: "text" });
    g.set(r, 2, GROUP_NAME[rt.group], { fill: FILL[rt.group] });
    g.set(r, 3, role?.jabatan ?? rt.roleId, { style: "muted" });
    g.set(r, 4, rt.weight, {
      fmt: "0.0000",
      src: "hitung",
      ...(src
        ? {
            f: n > 1 ? `${src}/${n}` : src,
            explain:
              n > 1
                ? `Bobot ${rt.name} = bobot total ${role?.jabatan} ÷ ${n} unit = ${num(role?.bobotTotal, 4)} ÷ ${n} = ${num(rt.weight, 4)}`
                : `Bobot ${rt.name} = bobot total jabatannya = ${num(rt.weight, 4)}`,
          }
        : {}),
    });
    g.anchor(`rw_${rt.id}`, r, 4);
    r++;
  }
  g.set(r, 3, "Jumlah", { style: "total" });
  g.set(r, 4, sum(o.raters.map((x) => x.weight)), {
    style: "total",
    fmt: "0.000",
    src: "hitung",
    f: r > r0 ? `SUM(E${r0 + 1}:E${r})` : "0",
    explain: "Jumlah bobot semua penilai = sub total (1)",
  });

  const main = g.build({
    cols: [16, 12, 28, 9, 11, 9, 9, 30, 60],
    notes: [
      "Matriks atas: baris = power (kemampuan memengaruhi keputusan), kolom = interest (kepentingan/keterlibatan). Manage Closely dilibatkan paling erat, Keep Satisfied dijaga kepuasannya, Keep Informed diberi informasi, Monitor cukup dipantau.",
      "Bobot kelompok dan bobot jabatan berasal dari perbandingan berpasangan AHP (sheet AHP). Bobot total = bobot × bobot kelompok; jumlah semuanya = 1.",
      "Anda bisa mengubah nama jabatan, power/interest (jabatan pindah kelompok), dan unit penilai; bobot dihitung ulang otomatis.",
      "Bila satu jabatan mewakili beberapa unit (mis. 4 biro), bobotnya dibagi rata ke setiap unit — itulah kolom penilai di IFAS/EFAS.",
    ],
  });

  // Sheet AHP (bobot kelompok & bobot jabatan per kelompok)
  const sheetViews: AhpView[] = [];
  const sets: AhpSheetSet[] = [];
  const jabatanOf = (id: string) => o.roles.find((x) => x.id === id)?.jabatan ?? id;
  if (views.kelompok) {
    sets.push({ raw: views.kelompok.raw, label: "Antarkelompok stakeholder (bobot kelompok)", path: [VIEW_TAG, sheetViews.length], itemLabel: (id) => STAKEHOLDER_GROUP_LABEL[id as StakeholderGroup] ?? id });
    sheetViews.push(views.kelompok);
  }
  for (const grp of STAKEHOLDER_GROUPS) {
    const view = views.byGroup[grp];
    if (!view) continue;
    sets.push({ raw: view.raw, label: `Jabatan dalam kelompok ${GROUP_NAME[grp]} (bobot jabatan)`, path: [VIEW_TAG, sheetViews.length], itemLabel: jabatanOf });
    sheetViews.push(view);
  }
  if (!sets.length) return [main];
  const ag = remapAhpEdits(
    ahpGrid({ id: "ahp", name: `AHP STAKEHOLDER ${SC}`, title: `AHP — bobot kelompok & jabatan (stakeholder ${scope})`, sets }),
    sheetViews,
  );
  ag.notes = [
    ...(ag.notes ?? []),
    "Perbandingan antarjabatan diisi untuk semua pasangan; yang dipakai hanya pasangan sesama anggota kelompok. Bila jabatan dipindah kelompok, perbandingannya dengan anggota baru sudah tersedia.",
  ];
  return [main, ag];
}

function stakeholderBlocks(o: StakeholderOut, label: string): Block[] {
  const rows = o.roles.map((r) => [
    GROUP_NAME[r.group],
    num(r.bobotKelompok),
    r.units?.length ? `${r.jabatan} (${r.units.join(", ")})` : r.jabatan,
    num(r.bobotJabatan),
    num(r.bobotTotal, 4),
  ]);
  return [
    { type: "h2", text: label },
    { type: "p", text: stakeholderSummary(o) },
    {
      type: "bullets",
      items: STAKEHOLDER_GROUPS.map((g) => {
        const rs = o.roles.filter((r) => r.group === g);
        return `${STAKEHOLDER_GROUP_LABEL[g]}: ${rs.length ? rs.map((r) => r.jabatan).join(", ") : "–"}`;
      }),
    },
    { type: "table", head: ["Kelompok", "Bobot kelompok", "Jabatan", "Bobot", "Bobot total"], rows: [...rows, ["SUB TOTAL", "", "", "", num(o.subtotal)]], widths: [18, 12, 40, 10, 12] },
    { type: "note", text: "Bobot kelompok dan bobot jabatan dihitung dengan AHP dari perbandingan berpasangan; bobot total = bobot × bobot kelompok." },
  ];
}

function stakeholderSummary(o: StakeholderOut): string {
  const parts = STAKEHOLDER_GROUPS.filter((g) => o.roles.some((r) => r.group === g)).map(
    (g) => `${GROUP_NAME[g]} ${o.roles.filter((r) => r.group === g).length} (bobot ${num(o.groups.find((x) => x.group === g)?.bobot ?? 0)})`,
  );
  return `${o.roles.length} jabatan ${o.scope}: ${parts.join(", ") || "–"}; ${o.raters.length} penilai ${o.scope === "internal" ? "IFAS" : "EFAS"}, sub total ${num(o.subtotal)}.`;
}

export const STAKEHOLDER_FORMULAS: FormulaDoc[] = [
  {
    name: "Kelompok stakeholder",
    rumus: "power tinggi & interest tinggi → Manage Closely (KP); power tinggi & interest rendah → Keep Satisfied (KS); power rendah & interest tinggi → Keep Informed (KI); keduanya rendah → Monitor (M)",
    arti: "Posisi jabatan di matriks power–interest menentukan seberapa erat ia dilibatkan dan kelompok bobotnya.",
  },
  { name: "Bobot kelompok", rumus: "AHP antarkelompok yang punya anggota (rata-rata geometrik baris ÷ jumlahnya)", arti: "Seberapa penting penilaian tiap kelompok; kelompok tanpa anggota berbobot 0." },
  { name: "Bobot jabatan", rumus: "AHP antarjabatan di dalam kelompok yang sama (1 bila jabatan sendirian)", arti: "Pembagian bobot kelompok kepada anggotanya; jumlah per kelompok = 1." },
  { name: "Bobot total", rumus: "Bobot total = Bobot jabatan × Bobot kelompok", arti: "Bobot akhir jabatan sebagai penilai IFAS/EFAS.", excel: "=D11*$B$11" },
  { name: "Sub total", rumus: "Σ bobot total", arti: "Harus 1 (semua jabatan bersama-sama = 100%).", excel: "=SUM(E11:E18)" },
  { name: "Bobot penilai unit", rumus: "Bobot penilai = Bobot total jabatan ÷ jumlah unit", arti: "Jabatan yang mewakili beberapa unit (mis. 4 biro) dibagi rata ke setiap unit.", excel: "=E12/4" },
];

// ---------- Prompt ----------

const SCOPE_TEXT: Record<StakeholderScope, string> = {
  internal: `Stakeholder INTERNAL = jabatan di DALAM kepengurusan organisasi (pimpinan, sekretariat/kesekjenan, biro, kementerian/departemen/divisi, sekretaris, staf) yang akan menjadi PENILAI faktor internal (Strength/Weakness) di IFAS.`,
  eksternal: `Stakeholder EKSTERNAL = pihak yang berkepentingan terhadap kondisi LINGKUNGAN LUAR organisasi dan akan menjadi PENILAI faktor eksternal (Opportunity/Threat) di EFAS. Biasanya pihak di luar kepengurusan (pimpinan kampus/fakultas, direktorat, dosen pembina, lembaga pengawas/legislatif mahasiswa, organisasi tingkat atas atau sejenis, alumni, mitra/sponsor). Bila dokumen menunjuk jabatan internal sebagai penilai faktor eksternal (contoh di Excel framework: Presiden BEM dan Sekjen menilai EFAS), jabatan itu boleh dimasukkan.`,
};

const QUERIES: Record<StakeholderScope, { focus: string; text: string; k: number }[]> = {
  internal: [
    { focus: "struktur", text: "struktur organisasi jabatan ketua wakil sekretaris bendahara kepala biro kementerian divisi wewenang tanggung jawab", k: 6 },
    { focus: "wewenang", text: "wewenang memimpin menetapkan menyetujui mengoordinasikan hubungan instruktif pengurus staf", k: 4 },
    { focus: "penilai", text: "penjaringan validasi stakeholder penilaian jabatan pemangku kepentingan internal", k: 4 },
  ],
  eksternal: [
    { focus: "pihak eksternal", text: "pihak eksternal kampus fakultas dekan rektorat direktorat dosen pembina mitra sponsor alumni", k: 6 },
    { focus: "pengawas", text: "lembaga pengawas dewan perwakilan mahasiswa legislatif organisasi lain himpunan BEM institut koordinasi", k: 4 },
    { focus: "penilai", text: "penjaringan validasi stakeholder penilaian eksternal pemangku kepentingan", k: 4 },
  ],
};

function stakeholderPrompt(ctx: NodeContext, scope: StakeholderScope) {
  const P = PREFIX[scope];
  return {
    system: `Kamu analis strategi organisasi. Petakan STAKEHOLDER ${scope.toUpperCase()} dengan matriks power–interest (Mendelow) HANYA dari potongan dokumen, lalu isi perbandingan berpasangan AHP untuk bobotnya. Hasilnya menjadi daftar penilai (kolom) di ${scope === "internal" ? "IFAS" : "EFAS"}.

APA YANG DIPETAKAN
- ${SCOPE_TEXT[scope]}
- Satu baris = satu JABATAN/PIHAK (mis. "Sekretaris Jenderal", "Kepala Biro", "Wakil Dekan bidang kemahasiswaan"). JANGAN menulis nama orang.
- ID berurutan ${P}1, ${P}2, ${P}3, … (urutkan dari yang paling berpengaruh). Jangan ada jabatan ganda.

POWER & INTEREST (isi "tinggi" atau "rendah")
- power = kemampuan memengaruhi keputusan/arah organisasi: wewenang memutuskan, menyetujui anggaran/proposal, mengawasi, memberi instruksi, menetapkan aturan.
- interest = besarnya kepentingan & keterlibatan pada program dan hasil organisasi: terdampak langsung, ikut menjalankan, sering berkoordinasi.
- Kelompok dihitung kode (jangan ditulis):
  power tinggi + interest tinggi → Manage Closely / Key Player (KP)
  power tinggi + interest rendah → Keep Satisfied (KS)
  power rendah + interest tinggi → Keep Informed (KI)
  power rendah + interest rendah → Monitor / Minimum Effort (M)
- reason: alasan singkat klasifikasi yang merujuk bukti.

UNIT PENILAI (opsional)
- Bila satu jabatan mewakili beberapa unit yang masing-masing akan menilai sendiri (mis. "Kepala Biro" untuk Biro Administrasi, Biro Keuangan, …), tulis nama unitnya di "units". Bobot jabatan dibagi rata ke setiap unit (4 biro → masing-masing ¼). Kosongkan bila jabatan menilai sebagai satu penilai.

BUKTI
${EVIDENCE_RULES}
- Jangan mengarang jabatan yang tidak disebut dokumen; dugaan tanpa bukti tulis sebagai pertanyaan di "unsupported".

${AHP_RULES}

HIMPUNAN AHP YANG WAJIB DIISI (field "ahp")
1. {"id":"kelompok","items":["KP","KS","KI","M"]} — seberapa penting penilaian kelompok a dibanding kelompok b bagi organisasi (biasanya KP > KS > KI > M). Isi keenam pasangan: ${pairList(["KP", "KS", "KI", "M"])}. Kelompok tanpa anggota otomatis berbobot 0.
2. {"id":"jabatan","items":[semua ID jabatan berurutan]} — seberapa penting pandangan/pengaruh jabatan a dibanding jabatan b. Isi SEMUA pasangan: n jabatan → n(n−1)/2 pasangan (contoh 4 jabatan: ${pairList([`${P}1`, `${P}2`, `${P}3`, `${P}4`])}). Bobot jabatan di dalam satu kelompok dihitung kode dari pasangan sesama anggota kelompok; pasangan lintas kelompok dipakai bila pengguna memindahkan jabatan ke kelompok lain.

${JSON_ONLY}`,
    user: `${orgLine(ctx)}

Potongan dokumen:
${evidenceBlock(ctx)}

Skema output:
${jsonSchemaText(StakeholderOutput)}`,
  };
}

// ---------- Mock (tanpa LLM) ----------

type RolePattern = { key: string; re: RegExp };
const INTERNAL_ROLES: RolePattern[] = [
  { key: "sekjen", re: /\bsekretaris jenderal\b|\bsekjen\b/i },
  { key: "sekmenko", re: /\bsekretaris (?:menteri koordinator|menko)\b|\bsekmenko\b/i },
  { key: "sekmen", re: /\bsekretaris (?:menteri|kementerian)\b|\bsekmen\b/i },
  { key: "sekum", re: /\bsekretaris umum\b/i },
  { key: "wakil", re: /\bwakil (?:ketua|presiden)(?: bem| umum)?\b/i },
  { key: "ketua", re: /\b(?:ketua|presiden)(?: bem| umum)?\b/i },
  { key: "bendahara", re: /\bbendahara(?: umum)?\b/i },
  { key: "kabiro", re: /\bkepala biro\b|\bkabiro\b/i },
  { key: "asbiro", re: /\basisten biro\b|\basbiro\b/i },
  { key: "menko", re: /\bmenteri koordinator\b|\bmenko\b/i },
  { key: "kepala", re: /\bkepala (?:kementerian|departemen|divisi|bidang)\b/i },
  { key: "menteri", re: /\bmenteri\b/i },
  { key: "staf", re: /\bstaf(?: kementerian)?\b/i },
];
const EXTERNAL_ROLES: RolePattern[] = [
  { key: "wadek", re: /\bwakil dekan(?: bidang kemahasiswaan)?\b/i },
  { key: "dekan", re: /\bdekan\b/i },
  { key: "rektor", re: /\bwakil rektor\b|\brektorat\b|\brektor\b/i },
  { key: "pembina", re: /\bdosen pembina\b/i },
  { key: "ditmawa", re: /\b[Dd]irektorat [Kk]emahasiswaan\b|\bDITMAWA\b/ },
  { key: "dpm", re: /\bdewan perwakilan mahasiswa\b|\bDPM\b/i },
  { key: "blm", re: /\bBLM\b|\blegislatif mahasiswa\b/ },
  { key: "bem-atas", re: /\bBEM (?:ITS|institut|universitas)\b/i },
  { key: "hmd", re: /\bhimpunan mahasiswa(?: departemen)?\b|\bHMD\b/i },
  { key: "ukm", re: /\bUKM\b/ },
  { key: "alumni", re: /\balumni\b/i },
  { key: "sponsor", re: /\bperusahaan(?: teknologi)?(?: calon sponsor)?\b|\bsponsor\b/i },
];
const POWER_RE =
  /\b(memimpin|menetapkan|menentukan|menyetujui|disetujui|berwenang|wewenang|mengawasi|berhak|bertanggung jawab|mengoordinasikan|meminta|memutuskan|alokasi|kontrol|mengintervensi|instruktif|mengesahkan)\b/i;
const POWER_STRONG = /\b(menetapkan|menyetujui|berwenang|mengawasi|memutuskan|berhak)\b/i;
const INTEREST_RE =
  /\b(program|kegiatan|mengelola|menjalankan|membantu|mendampingi|laporan|evaluasi|koordinasi|berkoordinasi|jejaring|tertarik|terlibat|sehari-hari|administrasi|bersedia|mendukung|agenda|anggaran)\b/i;

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Buang kata yang dinegasikan ("tidak berwenang") sebelum mencari kata kunci power/interest. */
const unnegated = (t: string) => t.replace(/\b(?:tidak|bukan|belum)\s+\S+/gi, " ");

/** Unit dari kalimat daftar, mis. "Ada enam kementerian: A, B, serta C." → ["Kementerian A", …]. */
function unitsFor(jabatan: string, sentences: string[]): string[] | undefined {
  const head = /\b(kementerian|biro|departemen|divisi)\b/i.exec(jabatan)?.[1]?.toLowerCase();
  if (!head || !/^kepala\b|^kabiro\b/i.test(jabatan)) return undefined;
  for (const s of sentences) {
    const m = new RegExp(`(?:ada|terdapat)\\s+[\\w-]+\\s+${head}\\s*:\\s*(.+)$`, "i").exec(s);
    if (!m) continue;
    const list = m[1]
      .replace(/[.!?]+$/, "")
      .split(/,\s*/)
      .map((x) => x.replace(/^(?:serta|dan)\s+/i, "").trim())
      .filter((x) => x.length > 2);
    if (list.length >= 2 && list.length <= 8) return list.map((x) => `${capFirst(head)} ${x}`);
  }
  return undefined;
}

export function mockStakeholder(ctx: NodeContext, scope: StakeholderScope): StakeholderOutput {
  const P = PREFIX[scope];
  const patterns = scope === "internal" ? INTERNAL_ROLES : EXTERNAL_ROLES;
  const docs = ctx.evidence.filter((e) => e.kind === "document");
  const sentences = docs.flatMap((c) => sentencesOf(c.content).map((s) => ({ chunk: c, s })));
  type Found = { key: string; name: string; first: { chunkId: string; quote: string; pos: number }; all: string[]; subject: string[] };
  const found = new Map<string, Found>();
  for (const { chunk, s } of sentences) {
    let masked = s;
    for (const p of patterns) {
      const m = p.re.exec(masked);
      if (!m) continue;
      masked = masked.slice(0, m.index) + " ".repeat(m[0].length) + masked.slice(m.index + m[0].length);
      const f = found.get(p.key);
      const subj = m.index < 3 ? [s] : [];
      if (!f) found.set(p.key, { key: p.key, name: capFirst(m[0]), first: { chunkId: chunk.id, quote: s, pos: m.index }, all: [s], subject: subj });
      else {
        f.all.push(s);
        f.subject.push(...subj);
        if (m.index < 3 && f.first.pos >= 3) f.first = { chunkId: chunk.id, quote: s, pos: m.index };
      }
    }
  }
  const all = sentences.map((x) => x.s);
  let picked = [...found.values()].slice(0, 10);
  if (!picked.length) {
    const fallback = scope === "internal" ? ["Ketua", "Sekretaris", "Bendahara", "Kepala divisi"] : ["Pimpinan kampus", "Lembaga pengawas", "Mitra"];
    picked = fallback.map((name, i) => ({ key: `f${i}`, name, first: { chunkId: "", quote: "", pos: 99 }, all: [], subject: [] }));
  }
  const roles: RoleRaw[] = picked.map((f, i) => {
    // Kalimat yang menjadikan jabatan sebagai subjek lebih tepat menggambarkan wewenangnya.
    const text = unnegated((f.subject.length ? f.subject : f.all).join(" "));
    const units = scope === "internal" ? unitsFor(f.name, all) : undefined;
    const power: "tinggi" | "rendah" = POWER_RE.test(text) || (!f.all.length && i === 0) ? "tinggi" : "rendah";
    const interest: "tinggi" | "rendah" = INTEREST_RE.test(text) || (!f.all.length && i < 2) ? "tinggi" : "rendah";
    return {
      id: `${P}${i + 1}`,
      jabatan: f.name,
      power,
      interest,
      ...(units ? { units } : {}),
      reason: `Mode uji: power ${power} (${power === "tinggi" ? "ada kata wewenang/keputusan" : "tanpa kata wewenang"}), interest ${interest} di kalimat dokumen.`,
      evidence: f.first.quote ? [{ chunkId: f.first.chunkId, quote: f.first.quote }] : [],
    };
  });
  if (!roles.some((r) => r.power === "tinggi" && r.interest === "tinggi")) {
    const r = roles.find((x) => x.power === "tinggi") ?? roles[0];
    if (r) {
      r.power = "tinggi";
      r.interest = "tinggi";
    }
  }
  // AHP: kelompok KP > KS > KI > M; jabatan menurut kelompok lalu urutan
  const base: Record<StakeholderGroup, number> = { KP: 9, KS: 5, KI: 3, M: 1 };
  const rank = new Map<string, number>();
  const seen: Record<StakeholderGroup, number> = { KP: 0, KS: 0, KI: 0, M: 0 };
  for (const r of roles) {
    const g = groupOf(r.power, r.interest);
    rank.set(r.id, base[g] * Math.pow(0.6, seen[g]++));
  }
  return {
    roles,
    ahp: [
      mockAhpSet("kelompok", STAKEHOLDER_GROUPS, (g) => base[g as StakeholderGroup]),
      mockAhpSet(
        "jabatan",
        roles.map((r) => r.id),
        (id) => rank.get(id) ?? 1,
      ),
    ],
    unsupported: found.size ? [] : [`Jabatan/pihak ${scope} apa saja yang terlibat dan menilai faktor ${scope === "internal" ? "internal" : "eksternal"} organisasi?`],
  };
}

// ---------- Validasi ----------

export const STAKEHOLDER_CHECKS: CheckSpec[] = [
  { name: "quote_exists", kind: "code", description: "Kutipan bukti jabatan tidak ditemukan di potongan dokumen yang dirujuk" },
  { name: "grounded", kind: "code", description: "Jabatan tidak punya kutipan dokumen sama sekali" },
  { name: "role_id", kind: "code", description: "ID jabatan ganda atau tidak berformat SI1, SI2, … / SE1, SE2, …" },
  { name: "duplicate_role", kind: "code", description: "Jabatan yang sama muncul lebih dari sekali" },
  { name: "key_player", kind: "code", description: "Tidak ada jabatan di kelompok Manage Closely (power & interest tinggi)" },
  { name: "units_valid", kind: "code", description: "Unit penilai kosong atau ganda" },
  { name: "ahp_complete", kind: "code", description: "Ada perbandingan AHP (antarkelompok atau antarjabatan sekelompok) yang belum diisi atau merujuk butir yang tidak ada" },
  { name: "ahp_consistency", kind: "code", description: "Rasio konsistensi AHP (CR) lebih dari 0,10 — penilaian berpasangan saling bertentangan" },
  { name: "power_interest", kind: "llm", description: "Klasifikasi power/interest tidak sesuai dengan wewenang dan keterlibatan jabatan menurut bukti" },
];

export async function validateStakeholder(out: StakeholderOutput, ctx: NodeContext, llm: Parameters<NonNullable<NodeDef["validate"]>>[2], scope: StakeholderScope): Promise<CheckResult[]> {
  const roles = out.roles ?? [];
  const checks: CheckResult[] = [];
  const q = checkQuotes(
    roles.filter((r) => r.evidence.length),
    ctx.evidence,
  );
  checks.push({ ...q, failures: q.failures.map((f) => ({ ...f, message: f.message.replace(/^Faktor /, "Jabatan ") })) });
  checks.push(
    result(
      "grounded",
      "code",
      roles.filter((r) => !r.evidence.length).map((r) => ({ check: "grounded", itemId: r.id, message: `Jabatan ${r.id} (${r.jabatan}) ditolak: tidak punya kutipan dokumen.` })),
    ),
  );
  const idFail: Failure[] = [];
  const re = new RegExp(`^${PREFIX[scope]}\\d+$`);
  const ids = new Map<string, number>();
  for (const r of roles) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) idFail.push({ check: "role_id", itemId: id, message: `ID ${id} dipakai ${n} jabatan; setiap jabatan harus punya ID unik.` });
  for (const r of roles)
    if (!re.test(r.id)) idFail.push({ check: "role_id", itemId: r.id, message: `ID ${r.id} harus berformat ${PREFIX[scope]}1, ${PREFIX[scope]}2, ….` });
  checks.push(result("role_id", "code", idFail));
  const dup: Failure[] = [];
  roles.forEach((a, i) =>
    roles.slice(i + 1).forEach((b) => {
      if (normText(a.jabatan) === normText(b.jabatan) || similarity(a.jabatan, b.jabatan) >= 0.9)
        dup.push({ check: "duplicate_role", itemId: b.id, message: `Jabatan ${b.id} ("${b.jabatan}") sama dengan ${a.id} ("${a.jabatan}"); gabungkan atau gunakan "units".` });
    }),
  );
  checks.push(result("duplicate_role", "code", dup));
  checks.push(
    result(
      "key_player",
      "code",
      roles.length && !roles.some((r) => groupOf(r.power, r.interest) === "KP")
        ? [{ check: "key_player", message: "Tidak ada jabatan Manage Closely (power tinggi dan interest tinggi). Periksa lagi apakah pimpinan/pengambil keputusan utama sudah diklasifikasikan dengan benar." }]
        : [],
    ),
  );
  const unitFail: Failure[] = [];
  for (const r of roles) {
    const u = (r.units ?? []).map((x) => x.trim());
    if (u.some((x) => !x)) unitFail.push({ check: "units_valid", itemId: r.id, message: `Jabatan ${r.id}: ada nama unit yang kosong.` });
    if (new Set(u.map(normText)).size < u.length) unitFail.push({ check: "units_valid", itemId: r.id, message: `Jabatan ${r.id}: ada nama unit yang ganda.` });
  }
  checks.push(result("units_valid", "code", unitFail));
  const v = stakeholderViews(roles, out.ahp);
  const viewSets = [v.kelompok, ...STAKEHOLDER_GROUPS.map((g) => v.byGroup[g])].filter((x): x is AhpView => !!x).map((x) => x.raw);
  checks.push(checkAhpViews(viewSets, out.ahp ?? [], new Set([...STAKEHOLDER_GROUPS, ...roles.map((r) => r.id)]), viewLabel));
  checks.push(checkAhpViewsConsistency(viewSets, viewLabel));
  const byId = new Map(roles.map((r) => [r.id, r]));
  checks.push(
    await llmJudge(
      llm,
      "power_interest",
      "Periksa klasifikasi power (kemampuan memengaruhi keputusan: wewenang, persetujuan, pengawasan) dan interest (kepentingan/keterlibatan pada program organisasi) setiap jabatan. ok=false bila klasifikasi jelas bertentangan dengan bukti.",
      roles.map((r) => ({
        id: r.id,
        text: `${r.jabatan} [power ${r.power}, interest ${r.interest} → ${GROUP_NAME[groupOf(r.power, r.interest)]}] alasan: ${r.reason || "-"} | bukti: ${r.evidence.map((e) => `"${e.quote}"`).join("; ") || "-"}`,
      })),
      `Stakeholder ${scope}. Power tinggi = berwenang memutuskan/menyetujui/mengawasi; interest tinggi = terlibat/terdampak langsung oleh program.`,
      (id) => {
        const r = byId.get(id);
        if (!r) return true;
        return !(r.power === "rendah" && POWER_STRONG.test(unnegated(r.evidence.map((e) => e.quote).join(" "))));
      },
    ),
  );
  return checks;
}

// ---------- Definisi node ----------

function stakeholderItems(out: unknown, scope: StakeholderScope) {
  const o = asStakeholder(out, scope);
  return o.roles.map((r) => ({
    id: r.id,
    text: r.jabatan,
    detail: `${STAKEHOLDER_GROUP_LABEL[r.group]} (power ${r.power}, interest ${r.interest}) · bobot ${num(r.bobotJabatan)} × kelompok ${num(r.bobotKelompok)} = ${num(r.bobotTotal, 4)}${
      r.units?.length ? ` · unit: ${r.units.join(", ")}` : ""
    }`,
  }));
}

function makeStakeholderNode(scope: StakeholderScope): NodeDef<StakeholderOutput> {
  const label = scope === "internal" ? "Stakeholder internal" : "Stakeholder eksternal";
  return {
    key: KEY[scope],
    label,
    phase: 1,
    group: "es",
    sheetName: SHEET[scope],
    deps: [],
    kind: "llm",
    description: `Pemetaan ${scope === "internal" ? "jabatan internal" : "pihak eksternal"} pada matriks power–interest (Manage Closely, Keep Satisfied, Keep Informed, Monitor) dengan bobot kelompok dan bobot jabatan dari AHP; menjadi penilai ${scope === "internal" ? "IFAS" : "EFAS"}.`,
    computedBy: "LLM mengusulkan jabatan, power/interest, dan perbandingan AHP; kode menghitung kelompok, bobot AHP, bobot total, dan penilai",
    schema: StakeholderOutput,
    checks: STAKEHOLDER_CHECKS,
    queries: () => QUERIES[scope],
    prompt: (ctx) => stakeholderPrompt(ctx, scope),
    mock: (ctx) => mockStakeholder(ctx, scope),
    validate: (out, ctx, llm) => validateStakeholder(out, ctx, llm, scope),
    compute: (out) => computeStakeholder(out, scope),
    items: (out) => stakeholderItems(out, scope),
    repairHint:
      "Perbaiki hanya jabatan/perbandingan yang ditolak; jabatan lain salin apa adanya. Lengkapi SEMUA pasangan AHP yang disebut belum diisi. Bila bukti jabatan tidak ditemukan, hapus jabatan itu dan tulis pertanyaannya di unsupported.",
    sheets: (out: unknown) => stakeholderSheets(asStakeholder(out, scope), scope),
    blocks: (out: unknown, ctx: SheetContext) => stakeholderBlocks(asStakeholder(out, scope), ctx.label || label),
    formulas: STAKEHOLDER_FORMULAS,
    summary: (out) => stakeholderSummary(asStakeholder(out, scope)),
  };
}

export const stakeholderInternal = makeStakeholderNode("internal");
export const stakeholderEksternal = makeStakeholderNode("eksternal");
