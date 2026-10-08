// Kasus sintetis contoh: himpunan mahasiswa fiktif lengkap dengan dokumen dan kunci jawaban SWOT.
// Semua nama orang dan lembaga fiktif (sesuai aturan anonimisasi).

export const SYNTHETIC_PROJECT = {
  name: "HIMSI Universitas Nusantara Raya (sintetis)",
  orgType: "ormawa",
  description:
    "Himpunan Mahasiswa Sistem Informasi fiktif untuk uji alur. Dokumen ringkas dengan kunci jawaban faktor SWOT.",
};

export const SYNTHETIC_DOCUMENTS: { filename: string; isValues?: boolean; text: string }[] = [
  {
    filename: "LPJ Kepengurusan 2025.txt",
    text: `Laporan Pertanggungjawaban Kepengurusan HIMSI 2025

Bagian A. Program yang berjalan
1. Program riset rutin "Kelas Riset Data" berjalan setiap dua minggu sepanjang tahun dan diikuti rata-rata 35 anggota per sesi.
2. Mentor dosen aktif mendampingi tiga kelompok studi, sehingga dua tim berhasil meraih juara kompetisi data tingkat nasional.
3. Divisi Media rutin mengunggah dokumentasi kegiatan di Instagram himpunan dan jumlah pengikut naik menjadi 4.200 akun.
4. Kas himpunan tercatat sehat dengan saldo akhir Rp18.500.000 berkat penjualan merchandise dan iuran anggota.

Bagian B. Kendala internal
1. Regenerasi staf lambat: dari 40 staf, hanya 9 orang yang bersedia melanjutkan sebagai pengurus inti tahun berikutnya.
2. Dokumentasi program lemah karena laporan kegiatan sering terlambat dan tidak ada SOP penyusunan laporan.
3. Koordinasi antar-divisi kurang karena rapat pleno sering ditunda dan keputusan hanya dibahas di grup obrolan.
4. Kemampuan desain dan pengelolaan media sosial terbatas pada dua orang staf saja.

Bagian C. Struktur
Struktur kepengurusan terdiri dari ketua, sekretaris, bendahara, serta lima divisi: Akademik, Riset, Media, Hubungan Eksternal, dan Kaderisasi.`,
  },
  {
    filename: "Notulensi Rapat Evaluasi 12 Mei 2026.txt",
    text: `Notulensi Rapat Evaluasi Tengah Periode, 12 Mei 2026

Poin 1. Ketua menyampaikan bahwa gaya kepemimpinan selama ini terlalu terpusat sehingga staf jarang mengambil inisiatif.
Poin 2. Divisi Riset melaporkan Kelas Riset Data tetap ramai dan menjadi program unggulan yang paling dikenal mahasiswa.
Poin 3. Divisi Kaderisasi mencatat keaktifan staf menurun setelah UTS; hanya 55 persen staf hadir di kegiatan internal.
Poin 4. Bendahara menegaskan sistem pencatatan keuangan sudah memakai spreadsheet bersama dan diaudit setiap bulan.
Poin 5. Disepakati perlu pelatihan kepemimpinan dan manajemen proyek bagi pengurus karena banyak program kerja tertunda.
Poin 6. Divisi Hubungan Eksternal menyampaikan tiga perusahaan teknologi tertarik menjadi mitra pelatihan bersertifikat.`,
  },
  {
    filename: "Survei Kepuasan Anggota 2026.txt",
    text: `Ringkasan Survei Kepuasan Anggota HIMSI 2026 (responden 212 mahasiswa)

Temuan 1. Sebanyak 78 persen responden menilai Kelas Riset Data sangat bermanfaat bagi perkuliahan dan karier.
Temuan 2. Sebanyak 64 persen responden ingin lebih banyak pelatihan bersertifikat di bidang analisis data dan UI/UX.
Temuan 3. Responden mengeluhkan informasi kegiatan sering mendadak sehingga sulit mengatur jadwal kuliah.
Temuan 4. Minat mahasiswa baru terhadap karier data dan kecerdasan buatan meningkat tajam dibanding tahun lalu.
Temuan 5. Sebagian responden lebih memilih mengikuti bootcamp daring berbayar karena materinya dianggap lebih praktis.`,
  },
  {
    filename: "Kondisi Eksternal Kampus 2026.txt",
    text: `Catatan Kondisi Eksternal HIMSI 2026

Kebijakan kampus: Rektorat meluncurkan program hibah kegiatan mahasiswa berbasis proposal dengan dana hingga Rp25.000.000 per organisasi.
Kebijakan kampus: Fakultas memangkas anggaran kegiatan rutin ormawa sebesar 30 persen mulai semester ganjil 2026.
Persaingan: Komunitas data independen dan UKM teknologi lain di kampus semakin aktif mengadakan pelatihan serupa secara gratis.
Tren: Program magang dan sertifikasi industri Kampus Merdeka membuat mahasiswa mencari kegiatan yang diakui sebagai kredit.
Teknologi: Platform belajar daring dan media sosial video pendek menjadi kanal utama mahasiswa mencari informasi kegiatan.
Regulasi: Kampus menerapkan aturan perlindungan data pribadi yang lebih ketat untuk survei dan formulir pendaftaran.
Mitra: Alumni yang bekerja di perusahaan teknologi bersedia menjadi pemateri tanpa biaya bila dijadwalkan jauh hari.`,
  },
  {
    filename: "AD ART dan Nilai Organisasi.txt",
    isValues: true,
    text: `Anggaran Dasar HIMSI, Bab II Nilai dan Tujuan

Pasal 3. HIMSI menjunjung nilai keilmuan, kekeluargaan, integritas, dan kebermanfaatan bagi mahasiswa Sistem Informasi.
Pasal 4. Tujuan HIMSI adalah mengembangkan kompetensi akademik dan profesional anggota serta menjadi wadah aspirasi mahasiswa.
Pasal 5. Setiap kepengurusan wajib merumuskan rencana strategis yang selaras dengan nilai organisasi dan dievaluasi di akhir periode.`,
  },
  {
    filename: "Struktur Kepengurusan HIMSI 2026.txt",
    text: `Struktur dan Wewenang Kepengurusan HIMSI 2026

Ketua himpunan memimpin seluruh kepengurusan, memutuskan arah program, dan menjadi penanggung jawab utama di hadapan anggota dan fakultas.
Sekretaris mengelola administrasi, persuratan, arsip, dan notulensi rapat; sekretaris berwenang menegur divisi yang terlambat menyerahkan laporan.
Bendahara mengelola kas, anggaran program, dan laporan keuangan bulanan; setiap pengeluaran harus disetujui bendahara.
Kepala divisi (Akademik, Riset, Media, Hubungan Eksternal, Kaderisasi) memimpin program kerja divisinya dan melapor kepada ketua setiap dua minggu.
Staf divisi menjalankan program kerja sehari-hari; staf tidak berwenang mengambil keputusan anggaran.
Dewan penasihat (mantan ketua) memberi masukan strategis tetapi tidak terlibat dalam keputusan harian.`,
  },
  {
    filename: "Pihak Eksternal HIMSI 2026.txt",
    text: `Daftar Pihak Eksternal yang Berhubungan dengan HIMSI 2026

Ketua program studi menyetujui proposal kegiatan akademik dan sangat berkepentingan dengan prestasi mahasiswa.
Wakil dekan bidang kemahasiswaan menentukan alokasi anggaran ormawa fakultas dan memantau laporan pertanggungjawaban.
Dosen pembina mendampingi kegiatan himpunan dan menjadi penghubung dengan program studi.
BEM fakultas mengoordinasikan kalender kegiatan seluruh himpunan dan bisa menolak jadwal yang bentrok.
Alumni yang bekerja di perusahaan teknologi menjadi pemateri dan membuka jejaring magang, tetapi keterlibatannya tidak rutin.
Perusahaan mitra calon sponsor tertarik pada pelatihan bersertifikat dan menilai kerja sama dari laporan kegiatan.`,
  },
  {
    filename: "Penilaian Stakeholder HIMSI 2026.txt",
    text: `Ringkasan Penilaian Stakeholder terhadap Kondisi HIMSI 2026 (skala 1–4: 1 sangat lemah, 4 sangat kuat)

Ketua dan sekretaris menilai program Kelas Riset Data sangat kuat (4) dan sistem keuangan kuat (3 sampai 4).
Para kepala divisi menilai regenerasi staf sangat lemah (1) dan dokumentasi laporan lemah (2).
Bendahara menilai pencatatan keuangan sangat kuat (4) tetapi menilai koordinasi antar-divisi lemah (2).
Dewan penasihat menilai kepemimpinan terlalu terpusat sebagai kelemahan penting (1 sampai 2).
Dosen pembina menilai peluang hibah rektorat dan kemitraan industri sangat menjanjikan (4) dan ancaman pemangkasan anggaran cukup serius (2).
Wakil dekan kemahasiswaan menilai kesiapan himpunan menghadapi pemangkasan anggaran masih rendah (2) dan respons terhadap persaingan pelatihan gratis sedang (2 sampai 3).`,
  },
];

export const SYNTHETIC_GOLD: { quadrant: "S" | "W" | "O" | "T"; text: string }[] = [
  { quadrant: "S", text: "Program riset rutin Kelas Riset Data berjalan konsisten dan menjadi program unggulan" },
  { quadrant: "S", text: "Mentor dosen aktif dan prestasi kompetisi data nasional" },
  { quadrant: "S", text: "Keuangan sehat dengan sistem pencatatan yang diaudit bulanan" },
  { quadrant: "W", text: "Regenerasi staf lambat" },
  { quadrant: "W", text: "Dokumentasi dan pelaporan program lemah tanpa SOP" },
  { quadrant: "W", text: "Koordinasi antar-divisi dan kepemimpinan terlalu terpusat" },
  { quadrant: "W", text: "Keaktifan staf menurun dan keterampilan media terbatas" },
  { quadrant: "O", text: "Program hibah kegiatan mahasiswa dari rektorat" },
  { quadrant: "O", text: "Perusahaan teknologi dan alumni bersedia menjadi mitra pelatihan" },
  { quadrant: "O", text: "Minat mahasiswa terhadap karier data dan pelatihan bersertifikat meningkat" },
  { quadrant: "T", text: "Pemangkasan anggaran kegiatan rutin ormawa oleh fakultas" },
  { quadrant: "T", text: "Komunitas dan UKM lain mengadakan pelatihan serupa secara gratis" },
  { quadrant: "T", text: "Bootcamp daring berbayar dianggap lebih praktis" },
];
