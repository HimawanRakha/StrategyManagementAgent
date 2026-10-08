// Codebook anotasi bawaan (bisa diubah dan diberi versi di /settings).
export const DEFAULT_CODEBOOK = {
  version: "v0.1",
  text: `CODEBOOK ANOTASI GALAT — v0.1

Tandai setiap item (faktor, strategi, isu, sasaran, misi, program) sebagai GALAT atau TIDAK.
Nilai hanya isi item ini; galat yang jelas berasal dari input yang sudah salah tetap ditandai,
tetapi peneliti akan memisahkannya sebagai galat terbawa saat menyusun putusan.

Jenis galat:
- unsupported      Klaim tidak didukung kutipan/dokumen, atau kutipan tidak ada di potongan sumber.
- wrong_quadrant   Faktor internal/eksternal atau positif/negatif tertukar (mis. kebijakan kampus ditulis sebagai Kelemahan).
- invalid_ref      Merujuk ID yang tidak ada atau tipe rujukan salah (mis. strategi SO merujuk faktor W).
- wrong_rating     Penilaian kepentingan/rating/AS tidak masuk akal atau melanggar konvensi (kekuatan diberi rating 1–2).
- contradiction    Bertentangan dengan item yang dirujuk atau dengan item lain.
- not_measurable   Target/KPI tidak memuat ukuran (angka, persentase, jumlah) atau tenggat.
- hallucination    Mengarang fakta, angka, atau pihak yang tidak ada di dokumen.
- other            Galat lain; jelaskan di catatan.

Aturan normalisasi kutipan: perbedaan spasi, huruf besar-kecil, dan tanda kutip tidak dihitung galat.
Kegagalan format JSON BUKAN galat analisis (dicatat terpisah oleh sistem).`,
};

export const ERROR_TYPES = [
  "unsupported",
  "wrong_quadrant",
  "invalid_ref",
  "wrong_rating",
  "contradiction",
  "not_measurable",
  "hallucination",
  "other",
] as const;
