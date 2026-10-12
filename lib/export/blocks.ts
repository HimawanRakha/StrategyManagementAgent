// Templat dokumen grand design yang sama untuk DOCX, PDF, dan pratinjau: dokumen → daftar blok netral.
// Modul murni (aman di client). Urutan: judul & catatan → ringkasan eksekutif → satu bab per kelompok tab Excel
// (ES, SGS, SI, LTV, MSDM, DM-CRM; analisis urut alur) → analisis tambahan (kustom) → lampiran jejak, sumber, galat.
import type { Block } from "@/lib/sheets/grid";
import type { DocSection, GrandDesignDoc } from "@/lib/grand-design/doc";
import { TRACE_KIND_LABEL } from "@/lib/grand-design/trace";
import { NODE_GROUPS } from "@/lib/nodes/groups";

export type { Block } from "@/lib/sheets/grid";

const MAX_LIST = 200;
const dateText = (iso: string | null | undefined) => {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleDateString("id-ID", { dateStyle: "long" });
  } catch {
    return iso.slice(0, 10);
  }
};
const capped = <T,>(xs: T[], n = MAX_LIST) => ({ list: xs.slice(0, n), more: Math.max(0, xs.length - n) });

function validationText(s: DocSection): string {
  if (!s.validation.enabled) return "tidak dipasang";
  if (!s.validation.checks.length) return s.available ? "belum ada catatan" : "-";
  return `${s.validation.passedChecks} lolos, ${s.validation.failed} gagal`;
}

/** Blok satu analisis: ringkasan, isi node (atau tabel butir), catatan edit/pemeriksaan, rumus yang dipakai. */
export function sectionBlocks(s: DocSection): Block[] {
  const b: Block[] = [{ type: "h2", text: s.label }];
  if (!s.available) {
    b.push({
      type: "note",
      text: `${s.label} belum tersedia (${s.statusLabel})${s.status === "failed" && s.error ? `: ${s.error}` : ""}. Bagian ini tidak dimasukkan ke dokumen.`,
    });
    return b;
  }
  if (s.summary) b.push({ type: "p", text: s.summary, italic: true });
  b.push(...s.blocks);
  if (s.fallback.blocks) b.push({ type: "note", text: "Tabel di atas disusun dari daftar butir hasil analisis (bentuk ringkas khusus belum tersedia)." });
  const notes: string[] = [];
  if (s.edits.count) notes.push(`${s.edits.count} nilai diubah manusia${s.edits.lastAt ? ` (terakhir ${dateText(s.edits.lastAt)})` : ""}`);
  if (s.validation.failed)
    notes.push(
      `pemeriksaan otomatis menemukan masalah pada ${s.validation.failed} pemeriksaan (${s.validation.checks
        .filter((c) => !c.passed)
        .map((c) => c.label)
        .join("; ")}) — rincian di lampiran`,
    );
  else if (s.validation.enabled && s.validation.checks.length) notes.push("semua pemeriksaan otomatis lolos");
  if (s.questions.length) notes.push(`${s.questions.length} pertanyaan agen belum dijawab`);
  if (notes.length) b.push({ type: "note", text: `Catatan: ${notes.join("; ")}.` });
  for (const e of s.renderErrors) b.push({ type: "note", text: `Galat penyusunan: ${e}` });
  if (s.formulas.length) {
    b.push({ type: "p", text: "Rumus yang dipakai:" });
    b.push({
      type: "table",
      head: ["Besaran", "Rumus", "Arti", "Excel"],
      widths: [18, 30, 37, 15],
      rows: s.formulas.map((f) => [f.name, f.rumus, f.arti, f.excel ?? ""]),
    });
  }
  return b;
}

export function docToBlocks(d: GrandDesignDoc): Block[] {
  const b: Block[] = [];
  let n = 0;
  const h1 = (t: string) => b.push({ type: "h1", text: `${++n}. ${t}` });
  b.push({
    type: "title",
    text: `Grand Design ${d.projectName}`,
    sub: `${d.orgType ? d.orgType + " · " : ""}DRAF hasil platform agen LLM — wajib ditelaah pengurus sebelum dipakai · run ${d.runId.slice(0, 8)} (${d.experimentTag}) · ${dateText(d.generatedAt)}`,
  });
  const analyses = d.unavailable.filter((u) => u.key !== "grand_design");
  if (analyses.length) b.push({ type: "note", text: `Bagian belum tersedia: ${analyses.map((u) => `${u.label} (${u.status})`).join(", ")}.` });
  const edited = d.sections.filter((s) => s.edits.count);
  if (edited.length)
    b.push({
      type: "note",
      text: `Nilai yang diubah manusia: ${edited.map((s) => `${s.label} (${s.edits.count})`).join(", ")}. Angka di dokumen ini sudah memakai nilai yang diubah.`,
    });
  const failing = d.sections.filter((s) => s.validation.failed || s.status === "failed" || s.renderErrors.length);
  if (failing.length) b.push({ type: "note", text: `Ada catatan galat/pemeriksaan pada: ${failing.map((s) => s.label).join(", ")} — lihat lampiran.` });
  if (Object.values(d.sources).some((s) => s.kind === "user_answer"))
    b.push({ type: "note", text: "Sumber berlabel U… adalah jawaban pengguna atas pertanyaan agen, bukan dokumen." });

  // 1. Ringkasan eksekutif
  h1("Ringkasan eksekutif");
  if (d.executiveSummary?.length) b.push({ type: "p", text: d.executiveSummary.map((s) => `${s.text} [${s.refs.join(", ")}]`).join(" ") });
  else b.push({ type: "note", text: `Ringkasan eksekutif belum tersedia (${d.executiveStatus}). Jalankan node grand design untuk menyusunnya.` });
  if (d.keyResults.length) {
    b.push({ type: "p", text: "Hasil utama tiap analisis:" });
    b.push({ type: "bullets", items: d.keyResults.map((k) => `${k.label}: ${k.text}`) });
  }

  // 2. Satu bab per kelompok tab Excel (analisis urut alur)
  for (const g of NODE_GROUPS) {
    if (g.id === "output") continue;
    const secs = d.sections.filter((s) => s.group === g.id);
    if (!secs.length) continue;
    h1(`${g.label} (${g.code})`);
    for (const s of secs) b.push(...sectionBlocks(s));
  }
  const custom = d.sections.filter((s) => s.group === "custom" || s.group === "output");
  if (custom.length) {
    h1("Analisis tambahan");
    for (const s of custom) b.push(...sectionBlocks(s));
  }

  b.push(...appendixBlocks(d));
  return b;
}

/** Lampiran A (jejak rujukan), B (sumber kutipan), C (galat dan pemeriksaan) — dipakai dokumen grand design dan laporan kajian. */
export function appendixBlocks(d: GrandDesignDoc): Block[] {
  const b: Block[] = [];
  // Lampiran A: jejak rujukan
  b.push({ type: "h1", text: "Lampiran A. Jejak rujukan" });
  b.push({
    type: "p",
    text: d.trace.total
      ? `Ketertelusuran: ${d.trace.complete} dari ${d.trace.total} elemen (strategi, inisiatif SI, sasaran SO, misi, dan butir berujukan) rantai rujukannya sampai ke kutipan dokumen atau jawaban pengguna.`
      : "Belum ada elemen berujukan yang bisa ditelusuri.",
  });
  if (d.trace.broken.length) {
    const c = capped(d.trace.broken);
    b.push({ type: "bullets", items: [...c.list.map((x) => `${x.id}: ${x.reason}`), ...(c.more ? [`… dan ${c.more} lainnya`] : [])] });
  }
  if (d.trace.chains.length) {
    const c = capped(d.trace.chains, 120);
    b.push({
      type: "table",
      head: ["Elemen", "Jenis", "Lengkap", "Rantai rujukan"],
      widths: [12, 16, 10, 62],
      rows: c.list.map((x) => [x.id, TRACE_KIND_LABEL[x.kind] ?? x.kind, x.complete ? "ya" : "TIDAK", x.path]),
    });
    if (c.more) b.push({ type: "note", text: `… dan ${c.more} rantai lainnya (lihat file XLSX).` });
  }

  // Lampiran B: sumber kutipan
  b.push({ type: "h1", text: "Lampiran B. Sumber kutipan" });
  const src = Object.entries(d.sources);
  if (src.length)
    b.push({
      type: "table",
      head: ["ID", "Sumber", "Isi potongan"],
      widths: [8, 20, 72],
      rows: src.map(([id, s]) => [
        id,
        s.kind === "user_answer" ? "Jawaban pengguna" : s.source,
        s.content ? (s.content.length > 600 ? s.content.slice(0, 600) + "…" : s.content) : "(isi potongan tidak ditemukan)",
      ]),
    });
  else b.push({ type: "p", text: "Tidak ada kutipan dokumen pada analisis yang tersedia." });

  // Lampiran C: catatan galat dan pemeriksaan
  b.push({ type: "h1", text: "Lampiran C. Catatan galat dan pemeriksaan" });
  if (d.sections.length)
    b.push({
      type: "table",
      head: ["Analisis", "Status", "Pemeriksaan otomatis", "Diubah manusia"],
      widths: [34, 22, 26, 18],
      rows: d.sections.map((s) => [s.label, s.statusLabel, validationText(s), s.edits.count ? `${s.edits.count} nilai` : "-"]),
    });
  const issues: string[] = [];
  for (const s of d.sections) {
    if (s.status === "failed") issues.push(`${s.label} — gagal dijalankan: ${s.error ?? "tanpa pesan"}`);
    for (const e of s.renderErrors) issues.push(`${s.label} — galat penyusunan: ${e}`);
    for (const c of s.validation.checks.filter((x) => !x.passed)) {
      const tag = `${s.label} — ${c.label} (${c.kind === "llm" ? "cek AI" : "cek kode"})`;
      if (!c.failures.length) issues.push(`${tag}: gagal`);
      for (const f of c.failures) issues.push(`${tag}: ${f.message}`);
    }
  }
  if (issues.length) {
    b.push({ type: "h2", text: "Pemeriksaan yang gagal dan galat" });
    const c = capped(issues);
    b.push({ type: "bullets", items: [...c.list, ...(c.more ? [`… dan ${c.more} lainnya (lihat sheet PEMERIKSAAN di file XLSX)`] : [])] });
  }
  if (d.questions.length) {
    b.push({ type: "h2", text: "Pertanyaan agen yang belum dijawab" });
    b.push({ type: "bullets", items: d.questions.map((q) => `${q.label} (${q.nodeLabel}): ${q.question}`) });
  }
  if (!issues.length && !d.questions.length) b.push({ type: "p", text: "Tidak ada pemeriksaan yang gagal, galat, atau pertanyaan agen yang terbuka." });
  return b;
}
