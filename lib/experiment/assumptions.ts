// Angka ASUMSI (tetap dan terdokumentasi) untuk model penempatan validator/tinjauan, dipakai bila belum ada angka
// terukur dari eksperimen. Angka ini sengaja tidak bergantung pada run atau penempatan saat ini, agar rekomendasi
// selalu sama untuk masukan yang sama. Modul murni (aman di client).

export const ASSUMED = {
  /** Peluang analisis yang disusun AI keliru bila tidak diperiksa (rata-rata contoh brief: SWOT 0,20 · IFAS/EFAS 0,06 · TOWS 0,13). */
  e: 0.15,
  /** Peluang analisis yang dihitung program (bukan AI) keliru. */
  eCode: 0.03,
  /** Peluang validator menemukan kekeliruan DAN berhasil memperbaikinya (d × r). */
  dr: 0.6,
  /** Token AI tambahan untuk satu kali pemeriksaan + perbaikan oleh validator. */
  cTok: 1500,
  /** Menit pengurus untuk meninjau satu analisis. */
  cMin: 5,
  /** Peluang peninjau manusia menangkap kekeliruan. */
  dh: 0.85,
} as const;

/** Alasan singkat tiap asumsi (ditampilkan di laporan). */
export const ASSUMED_WHY = {
  e: "perkiraan awal: rata-rata galat analisis AI pada contoh penelitian (0,06–0,20)",
  eCode: "analisis yang dihitung program jarang keliru; sisa peluang berasal dari data masukan",
  dr: "perkiraan awal: validator menangkap dan memperbaiki sekitar 6 dari 10 kekeliruan",
  cTok: "perkiraan awal biaya satu siklus periksa + perbaiki",
  cMin: "perkiraan awal waktu membaca satu tabel analisis",
  dh: "perkiraan awal: peninjau teliti menangkap sekitar 85 dari 100 kekeliruan",
} as const;

/** Jumlah data minimum agar proporsi terukur (e, d×r) dipakai menggantikan asumsi. */
export const MIN_N = 5;
