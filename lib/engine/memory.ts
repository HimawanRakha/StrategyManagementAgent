// Memori inti organisasi (context engineering): ringkasan pendek yang SELALU disisipkan ke prompt setiap analisis,
// agar analisis di ujung alur (MSDM, DM-CRM, kustom) tidak "lupa" profil, visi–misi, posisi strategis, strategi
// terpilih, serta kelemahan dan ancaman utama organisasi. Disusun dari hasil analisis yang SUDAH selesai di run ini
// (bukan dari AI), dibatasi ±1.500 karakter, dan tidak memuat hasil analisis itu sendiri. Modul murni.
import type { CascadingComputed, FaktorComputed, PosisiComputed, QspmComputedV2, RenstraComputed } from "@/lib/nodes/contracts";
import type { NodeContext } from "@/lib/nodes/types";

export const MEMORY_MAX_CHARS = 1500;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Teks memori inti untuk analisis `nodeKey`; null bila belum ada isi selain nama organisasi. */
export function coreMemory(ctx: Pick<NodeContext, "projectName" | "orgType" | "description" | "inputs">, nodeKey: string): string | null {
  const out = ctx.inputs as Record<string, unknown>;
  const lines: string[] = [];
  if (ctx.description?.trim()) lines.push(`Profil: ${cut(ctx.description.trim().replace(/\s+/g, " "), 300)}`);

  const cas = nodeKey !== "cascading" ? (out.cascading as CascadingComputed | undefined) : undefined;
  const ren = nodeKey !== "renstra" ? (out.renstra as RenstraComputed | undefined) : undefined;
  const visi = cas?.visi || ren?.visi;
  if (visi) lines.push(`Visi: ${cut(visi, 220)}`);
  const misi = cas?.aspects?.map((a) => a.misi).filter(Boolean) ?? ren?.misi ?? [];
  if (misi.length) lines.push(`Misi: ${misi.slice(0, 5).map((m, i) => `(${i + 1}) ${cut(m, 110)}`).join(" ")}`);

  const pos = nodeKey !== "posisi_organisasi" ? (out.posisi_organisasi as PosisiComputed | undefined) : undefined;
  if (pos?.kuadran) lines.push(`Posisi strategis: Kuadran ${pos.kuadran} (${pos.strategi}); arah strategi utama ${pos.fokus}.`);

  const qspm = nodeKey !== "qspm" ? (out.qspm as QspmComputedV2 | undefined) : undefined;
  if (qspm?.ranking?.length) lines.push(`Strategi prioritas (QSPM): ${qspm.ranking.slice(0, 3).map((r) => `${r.id} ${cut(r.text, 120)}`).join("; ")}.`);

  const top = (k: "faktor_internal" | "faktor_eksternal", q: "W" | "T", label: string) => {
    const f = nodeKey !== k ? (out[k] as FaktorComputed | undefined) : undefined;
    const xs = (f?.factors ?? []).filter((x) => x.quadrant === q).sort((a, b) => (b.bobot ?? 0) - (a.bobot ?? 0)).slice(0, 3);
    if (xs.length) lines.push(`${label}: ${xs.map((x) => `${x.id} ${cut(x.text, 90)}`).join("; ")}.`);
  };
  top("faktor_internal", "W", "Kelemahan utama (bobot terbesar)");
  top("faktor_eksternal", "T", "Ancaman utama (bobot terbesar)");

  if (!lines.length) return null;
  const head = `MEMORI INTI ORGANISASI — ${ctx.projectName}${ctx.orgType ? ` (${ctx.orgType})` : ""}. Konteks tetap dari hasil analisis sebelumnya: selaraskan analisis ini dengannya dan jangan bertentangan; rujuk ID-nya (mis. W2, SO1) bila relevan. Memori ini BUKAN bukti dokumen — bukti tetap wajib dari potongan dokumen.`;
  let text = `${head}\n- ${lines.join("\n- ")}`;
  if (text.length > MEMORY_MAX_CHARS) text = cut(text, MEMORY_MAX_CHARS);
  return text;
}
