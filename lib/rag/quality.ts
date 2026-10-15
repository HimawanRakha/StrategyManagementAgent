// Pemeriksaan otomatis dokumen saat diunggah (tinjauan dokumen baru). Modul murni.
// Hasilnya ditampilkan sebagai peringatan; pengguna tetap yang memutuskan dokumen disetujui atau dihapus.
import type { DocQuality } from "@/lib/db/schema";
import type { RawChunk } from "./chunk";

/** Sidik teks untuk mendeteksi dokumen duplikat (huruf kecil, spasi dirapatkan). */
export function textFingerprint(text: string) {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${t.length}:${(h >>> 0).toString(16)}`;
}

export function assessDocument(rawText: string, chunks: RawChunk[], existing: { filename: string; fingerprint: string }[] = []): DocQuality {
  const warnings: NonNullable<DocQuality["warnings"]> = [];
  const text = rawText.trim();
  const lens = chunks.map((c) => c.content.length);
  const stats = {
    chars: text.length,
    chunks: chunks.length,
    avgChunk: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
    minChunk: lens.length ? Math.min(...lens) : 0,
    maxChunk: lens.length ? Math.max(...lens) : 0,
  };
  if (!chunks.length) warnings.push({ code: "kosong", message: "Tidak ada potongan yang terbentuk — dokumen kosong atau tidak terbaca." });
  else if (text.length < 300)
    warnings.push({ code: "pendek", message: `Dokumen sangat pendek (${text.length} karakter); bukti yang bisa diambil analisis sedikit.` });

  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (text.length > 50 && letters / text.length < 0.55)
    warnings.push({
      code: "simbol",
      message: `Hanya ${Math.round((letters / text.length) * 100)}% isi berupa huruf — mungkin hasil pindaian, tabel angka, atau ekstraksi yang rusak. Periksa potongannya.`,
    });

  const broken = (text.match(/�/g) ?? []).length;
  if (broken) warnings.push({ code: "karakter_rusak", message: `${broken} karakter tidak terbaca (�) — kemungkinan masalah encoding file.` });

  const lines = text.split(/\n/).filter((l) => l.trim());
  const tableLike = lines.filter((l) => /\t|\s{3,}\S+\s{3,}|\|.*\|/.test(l)).length;
  if (lines.length >= 5 && tableLike / lines.length > 0.3)
    warnings.push({
      code: "tabel",
      message: `${tableLike} dari ${lines.length} baris tampak seperti tabel; susunan kolom bisa rusak saat dipotong. Pertimbangkan menempel tabel sebagai kalimat.`,
    });

  const fp = textFingerprint(text);
  const dup = existing.find((e) => e.fingerprint === fp);
  if (dup) warnings.push({ code: "duplikat", message: `Isinya sama dengan dokumen "${dup.filename}" yang sudah ada — bukti akan terhitung dua kali.` });

  if (stats.maxChunk > 1500) warnings.push({ code: "potongan_panjang", message: `Ada potongan sepanjang ${stats.maxChunk} karakter (paragraf tanpa titik); pencarian bisa kurang tepat.` });
  return { warnings, stats };
}
