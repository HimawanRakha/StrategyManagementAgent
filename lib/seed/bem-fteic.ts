// DATA DUMMY BEM FTEIC ITS untuk uji coba alur. Semua isi fiktif — ganti dengan dokumen asli (dianonimkan)
// sebelum dipakai sungguhan. Kunci = label node input di canvas.

export const BEM_DESCRIPTION =
  "Badan Eksekutif Mahasiswa Fakultas Teknologi Elektro dan Informatika Cerdas (FTEIC), Institut Teknologi Sepuluh Nopember (ITS) Surabaya. Wadah aspirasi, advokasi, dan pengembangan potensi mahasiswa lintas departemen di fakultas.";

export type DummyDoc = { filename: string; text: string };

export const BEM_DOCS: Record<string, DummyDoc> = {
  KERESAHAN: {
    filename: "DUMMY KERESAHAN mahasiswa FTEIC.txt",
    text: `DATA DUMMY untuk uji coba — Rangkuman keresahan mahasiswa FTEIC (hasil serap aspirasi, anonim)

Keresahan 1. Mahasiswa merasa informasi kegiatan BEM FTEIC sering terlambat sampai, sehingga banyak yang baru tahu ketika pendaftaran sudah ditutup.

Keresahan 2. Mahasiswa lintas departemen merasa kegiatan BEM FTEIC lebih sering dihadiri mahasiswa dari departemen yang dekat dengan pengurus, sehingga keterlibatan antardepartemen tidak merata.

Keresahan 3. Banyak mahasiswa tingkat awal dan tingkat akhir bingung harus menyampaikan aspirasi akademik ke mana, karena jalur advokasi akademik BEM tidak dikenal.

Keresahan 4. Pengurus BEM mengeluhkan beban ganda antara kepanitiaan, kuliah, dan praktikum sehingga banyak program kerja selesai tanpa evaluasi.

Keresahan 5. Pengurus merasa pergantian kepengurusan selalu menyisakan dokumentasi yang tidak lengkap, sehingga program yang sudah berjalan harus dirancang ulang dari nol.

Keresahan 6. Mahasiswa merasa program BEM FTEIC kurang berdampak pada peningkatan kompetensi, karena lebih banyak berupa acara seremonial daripada pelatihan keterampilan.

Keresahan 7. Dana kegiatan terbatas dan bergantung pada alokasi fakultas, sementara kerja sama dengan mitra eksternal belum terbangun secara berkelanjutan.`,
  },

  AMBISI: {
    filename: "DUMMY AMBISI kepengurusan BEM FTEIC.txt",
    text: `DATA DUMMY untuk uji coba — Ambisi kepengurusan BEM FTEIC

Ambisi 1. BEM FTEIC ingin menjadi pusat kolaborasi mahasiswa lintas departemen yang diakui sebagai wadah aspirasi utama di fakultas pada akhir masa kepengurusan.

Ambisi 2. Kepengurusan menargetkan minimal 70 persen mahasiswa FTEIC mengenal jalur aspirasi dan advokasi akademik BEM.

Ambisi 3. BEM FTEIC ingin memiliki sistem dokumentasi dan serah terima program yang rapi, sehingga setiap program kerja punya arsip lengkap dan bisa dilanjutkan kepengurusan berikutnya.

Ambisi 4. Kepengurusan ingin membangun minimal lima kemitraan berkelanjutan dengan industri dan komunitas teknologi untuk pelatihan, magang, dan pendanaan kegiatan.

Ambisi 5. BEM FTEIC ingin menyelenggarakan paling sedikit enam program pengembangan kompetensi per tahun yang diikuti minimal 300 mahasiswa dari seluruh departemen.

Ambisi 6. Pengurus ingin membuat kanal komunikasi digital yang terpadu, sehingga informasi kegiatan sampai kepada mahasiswa paling lambat tiga hari sebelum pendaftaran dibuka.

Ambisi 7. BEM FTEIC ingin dikenal sebagai organisasi yang transparan, dengan laporan kegiatan dan keuangan yang dipublikasikan setiap semester.`,
  },

  HARAPAN: {
    filename: "DUMMY HARAPAN pemangku kepentingan.txt",
    text: `DATA DUMMY untuk uji coba — Harapan mahasiswa, dosen, pimpinan fakultas, himpunan, dan alumni terhadap BEM FTEIC

Harapan 1. Mahasiswa berharap BEM FTEIC menyediakan wadah aspirasi yang mudah diakses dan memberi umpan balik dalam waktu satu minggu.

Harapan 2. Mahasiswa berharap ada program yang menjangkau semua departemen secara adil, termasuk kegiatan daring bagi yang sedang praktik atau kerja lapangan.

Harapan 3. Dosen pembina berharap BEM FTEIC menyusun rencana kerja tahunan yang selaras dengan arah fakultas dan terdokumentasi dengan baik.

Harapan 4. Pimpinan fakultas berharap BEM FTEIC menjadi mitra dalam mengomunikasikan kebijakan kemahasiswaan dan menyerap masukan mahasiswa secara teratur.

Harapan 5. Himpunan mahasiswa departemen berharap koordinasi dengan BEM FTEIC dilakukan sejak tahap perencanaan, sehingga jadwal kegiatan tidak bentrok.

Harapan 6. Alumni berharap BEM FTEIC membuka ruang kolaborasi untuk berbagi pengalaman karier dan membuka akses jejaring industri bagi mahasiswa.

Harapan 7. Mahasiswa baru berharap mendapat pendampingan awal agar cepat mengenal lingkungan fakultas, layanan akademik, dan peluang organisasi.`,
  },

  "Kondisi eksternal": {
    filename: "DUMMY Kondisi eksternal BEM FTEIC 2026.txt",
    text: `DATA DUMMY untuk uji coba — Catatan kondisi eksternal BEM FTEIC 2026

Kebijakan: Fakultas menerapkan skema pendanaan kegiatan berbasis proposal dengan plafon Rp15.000.000 per program kerja BEM untuk tahun anggaran berjalan.

Kebijakan: Institut mewajibkan seluruh organisasi kemahasiswaan menyerahkan laporan pertanggungjawaban paling lambat 14 hari setelah kegiatan berakhir.

Kebijakan: Pimpinan fakultas membuka program kolaborasi kemahasiswaan dengan dukungan ruang dan fasilitas bagi organisasi yang menyerahkan rencana kerja tahunan tepat waktu.

Persaingan: Himpunan mahasiswa departemen dan unit kegiatan mahasiswa teknologi semakin aktif menyelenggarakan pelatihan serupa, sehingga perhatian mahasiswa terbagi.

Persaingan: Komunitas belajar daring dan bootcamp berbayar menawarkan pelatihan keterampilan yang dianggap lebih praktis oleh sebagian mahasiswa.

Tren: Minat mahasiswa terhadap kecerdasan buatan, ilmu data, dan keamanan siber meningkat, sehingga permintaan pelatihan di bidang itu naik tajam.

Tren: Mahasiswa semakin memilih kegiatan yang memberi sertifikat dan diakui sebagai kegiatan penunjang karier.

Teknologi: Instagram dan platform video pendek menjadi kanal utama mahasiswa mencari informasi kegiatan fakultas.

Mitra: Beberapa perusahaan teknologi dan alumni bersedia menjadi pemateri dan sponsor bila proposal diajukan minimal dua bulan sebelum kegiatan.

Regulasi: Kampus menerapkan aturan perlindungan data pribadi yang lebih ketat untuk survei dan formulir pendaftaran.`,
  },

  "Survei anggota": {
    filename: "DUMMY Survei kepuasan mahasiswa 2026.txt",
    text: `DATA DUMMY untuk uji coba — Ringkasan survei kepuasan mahasiswa terhadap BEM FTEIC 2026 (340 responden dari seluruh departemen)

Temuan 1. Sebanyak 41 persen responden menyatakan tidak mengetahui jalur penyampaian aspirasi akademik ke BEM FTEIC.

Temuan 2. Sebanyak 68 persen responden menilai kegiatan pengembangan kompetensi seperti pelatihan dan lomba sebagai program BEM yang paling bermanfaat.

Temuan 3. Sebanyak 57 persen responden mengaku informasi kegiatan BEM biasanya diterima kurang dari tiga hari sebelum pendaftaran ditutup.

Temuan 4. Skor kepuasan umum terhadap kinerja BEM FTEIC adalah 3,4 dari 5, dengan skor terendah pada aspek transparansi laporan keuangan sebesar 2,9.

Temuan 5. Sebanyak 62 persen responden berminat menjadi panitia atau relawan jika ada pendampingan dan pembagian beban yang jelas.

Temuan 6. Responden dari departemen dengan jumlah mahasiswa kecil melaporkan keterlibatan yang lebih rendah, yaitu rata-rata hanya 12 persen yang pernah mengikuti kegiatan BEM.

Temuan 7. Sebanyak 73 persen responden lebih memilih menerima informasi kegiatan melalui Instagram dibanding grup pesan atau surel.`,
  },

  "Notulensi rapat": {
    filename: "DUMMY Notulensi rapat evaluasi 14 Maret 2026.txt",
    text: `DATA DUMMY untuk uji coba — Notulensi rapat evaluasi tengah periode BEM FTEIC, 14 Maret 2026 (dihadiri 28 pengurus)

Poin 1. Ketua BEM menyampaikan bahwa hanya 9 dari 16 program kerja semester pertama yang memiliki laporan lengkap dan terdokumentasi.

Poin 2. Kementerian Komunikasi dan Informasi melaporkan jangkauan Instagram BEM naik menjadi 6.800 pengikut, tetapi interaksi per unggahan masih rendah.

Poin 3. Kementerian Pengembangan Sumber Daya Mahasiswa mencatat kehadiran pengurus pada kegiatan internal menurun menjadi 58 persen setelah ujian tengah semester.

Poin 4. Bendahara melaporkan realisasi anggaran baru mencapai 46 persen dan menyatakan proses pencairan dana fakultas sering terlambat karena kelengkapan berkas.

Poin 5. Disepakati bahwa seluruh kementerian wajib menyerahkan rencana kerja dan penanggung jawab program paling lambat dua minggu sebelum kegiatan.

Poin 6. Kementerian Advokasi menyampaikan bahwa tiga aspirasi mahasiswa terkait jadwal praktikum telah diteruskan ke fakultas, tetapi belum ada tindak lanjut tertulis.

Poin 7. Rapat menyepakati perlunya pelatihan manajemen proyek dan kepemimpinan bagi pengurus karena banyak program kerja tertunda.`,
  },

  "LPJ / laporan kegiatan": {
    filename: "DUMMY LPJ kepengurusan sebelumnya.txt",
    text: `DATA DUMMY untuk uji coba — Ringkasan laporan pertanggungjawaban kepengurusan BEM FTEIC periode sebelumnya

Bagian A. Program yang berjalan

1. Program pelatihan keterampilan teknologi diselenggarakan sebanyak 4 kali dan diikuti rata-rata 85 peserta per sesi.

2. Kompetisi inovasi mahasiswa tingkat fakultas berhasil mengikutsertakan 24 tim dari lima departemen.

3. Program pendampingan mahasiswa baru diikuti 410 peserta dengan tingkat kepuasan 4,1 dari 5.

4. Layanan aspirasi akademik menerima 37 aduan dan 22 di antaranya diteruskan dengan tindak lanjut tertulis.

Bagian B. Keuangan

1. Total anggaran yang dikelola sebesar Rp62.000.000 dengan realisasi 81 persen.

2. Sumber dana utama berasal dari fakultas sebesar 74 persen, dan sisanya dari sponsor serta iuran kegiatan.

Bagian C. Kendala

1. Dokumentasi program tidak seragam, sehingga laporan beberapa kementerian terlambat lebih dari satu bulan.

2. Hanya 11 dari 35 pengurus yang bersedia melanjutkan sebagai kader kepengurusan berikutnya.

3. Koordinasi dengan himpunan departemen sering dilakukan mendadak, sehingga jadwal kegiatan bentrok.

4. Kerja sama sponsor bersifat sekali kegiatan dan tidak berlanjut ke program berikutnya.

Bagian D. Struktur

Struktur kepengurusan terdiri atas ketua, sekretaris umum, bendahara umum, dan enam kementerian.`,
  },

  "Nilai organisasi (AD/ART)": {
    filename: "DUMMY AD ART dan nilai organisasi.txt",
    text: `DATA DUMMY untuk uji coba — Kutipan AD/ART dan nilai organisasi BEM FTEIC

Pasal 3. BEM FTEIC menjunjung nilai integritas, kolaborasi, inovasi, dan keberpihakan kepada mahasiswa.

Pasal 4. BEM FTEIC bertujuan menjadi wadah aspirasi, advokasi, dan pengembangan potensi seluruh mahasiswa Fakultas Teknologi Elektro dan Informatika Cerdas.

Pasal 5. Setiap kepengurusan wajib menyusun rencana strategis dan program kerja yang selaras dengan arah fakultas dan nilai organisasi.

Pasal 6. Setiap kepengurusan wajib menyerahkan laporan pertanggungjawaban dan dokumen serah terima program kepada kepengurusan berikutnya.

Pasal 7. Pengelolaan keuangan BEM FTEIC dilakukan secara transparan dan dilaporkan kepada seluruh mahasiswa fakultas setiap semester.

Pasal 8. Pengambilan keputusan strategis dilakukan melalui musyawarah pengurus dengan mengutamakan mufakat.`,
  },

  "JURNAL/REFERENSI": {
    filename: "DUMMY Ringkasan referensi organisasi kemahasiswaan.txt",
    text: `DATA DUMMY untuk uji coba — Ringkasan referensi tentang organisasi kemahasiswaan yang efektif (ganti dengan jurnal dan referensi asli sebelum dipakai sungguhan)

Referensi 1. Organisasi kemahasiswaan yang efektif memiliki visi yang dipahami seluruh pengurus dan rencana kerja yang diturunkan menjadi indikator terukur.

Referensi 2. Organisasi dengan sistem dokumentasi dan serah terima yang baku cenderung mempertahankan kesinambungan program lintas kepengurusan.

Referensi 3. Keterlibatan anggota meningkat ketika organisasi menyediakan saluran aspirasi yang jelas dan memberi umpan balik dalam waktu singkat.

Referensi 4. Pengembangan kader yang terencana, seperti pelatihan kepemimpinan dan pendampingan, berkaitan dengan retensi pengurus yang lebih tinggi.

Referensi 5. Komunikasi digital yang konsisten dan berbasis kanal favorit anggota meningkatkan jangkauan informasi kegiatan.

Referensi 6. Kemitraan jangka panjang dengan industri dan alumni membantu organisasi memperoleh sumber daya dan memperluas jejaring anggota.

Referensi 7. Transparansi pelaporan program dan keuangan berkaitan dengan kepercayaan anggota terhadap organisasi.`,
  },

  "JARAS VALIDASI": {
    filename: "DUMMY Penjaringan dan validasi stakeholder (jaras validasi).txt",
    text: `DATA DUMMY untuk uji coba — Hasil penjaringan aspirasi dan validasi stakeholder BEM FTEIC (dipakai sebagai rating 1–4 tiap jabatan di IFAS dan EFAS)

Skala rating (sama untuk kekuatan, kelemahan, peluang, dan ancaman): seberapa setuju jabatan itu bahwa faktor tersebut BENAR-BENAR TERJADI di BEM FTEIC. 1 = tidak setuju, 2 = kurang setuju, 3 = setuju, 4 = sangat setuju. Rating tinggi pada kelemahan atau ancaman berarti masalah itu nyata, sehingga skornya makin mengurangi total IFAS/EFAS.

Penilaian internal 1. Ketua BEM dan Wakil Ketua sangat setuju (4) bahwa program pengembangan kompetensi dan kompetisi inovasi menjadi kekuatan BEM FTEIC.

Penilaian internal 2. Sekretaris Umum sangat setuju (4) bahwa dokumentasi dan serah terima program masih menjadi kelemahan, karena hanya 9 dari 16 program semester pertama yang laporannya lengkap.

Penilaian internal 3. Bendahara Umum setuju (3) bahwa pengelolaan keuangan tertib menjadi kekuatan, dan setuju (3) bahwa lambatnya pencairan dana fakultas menjadi kelemahan.

Penilaian internal 4. Para Kepala Kementerian sangat setuju (4) bahwa regenerasi dan kaderisasi pengurus lemah, dan setuju (3) bahwa jangkauan komunikasi digital menjadi kekuatan walau interaksi masih rendah.

Penilaian internal 5. Para Sekretaris Kementerian setuju (3) bahwa beban kerja pengurus yang tidak merata menjadi kelemahan.

Penilaian internal 6. Perwakilan staf setuju (3) bahwa budaya kolaborasi dan semangat pengurus menjadi kekuatan, dan setuju (3) bahwa SOP yang belum jelas menjadi kelemahan.

Penilaian eksternal 1. Wakil Dekan bidang kemahasiswaan setuju (3) bahwa program kolaborasi fakultas menjadi peluang bagi BEM FTEIC, dan sangat setuju (4) bahwa aturan pelaporan 14 hari menjadi ancaman bila dokumentasi tetap lemah.

Penilaian eksternal 2. Dosen pembina sangat setuju (4) bahwa kemitraan industri dan alumni adalah peluang besar yang belum dimanfaatkan.

Penilaian eksternal 3. Perwakilan BEM ITS setuju (3) bahwa sinergi dengan agenda institut menjadi peluang bagi BEM FTEIC.

Penilaian eksternal 4. Dewan Perwakilan Mahasiswa FTEIC sangat setuju (4) bahwa ketergantungan dana pada fakultas menjadi ancaman serius.

Penilaian eksternal 5. Perwakilan himpunan mahasiswa departemen setuju (3) bahwa persaingan program pelatihan antara HMD, UKM, dan BEM menjadi ancaman, karena jadwal sering bentrok.

Penilaian eksternal 6. Perwakilan alumni sangat setuju (4) bahwa meningkatnya minat mahasiswa pada kecerdasan buatan dan keamanan siber menjadi peluang.`,
  },

  "Struktur & jabatan organisasi": {
    filename: "DUMMY Struktur dan wewenang kepengurusan BEM FTEIC.txt",
    text: `DATA DUMMY untuk uji coba — Struktur dan wewenang kepengurusan BEM FTEIC (nama orang tidak dicantumkan)

Ketua BEM memimpin seluruh kepengurusan, menetapkan arah gerak kabinet, dan bertanggung jawab kepada mahasiswa FTEIC serta pimpinan fakultas.

Wakil Ketua BEM membantu ketua mengoordinasikan seluruh kementerian dan memimpin evaluasi bulanan program kerja.

Sekretaris Umum mengelola administrasi, persuratan, arsip, dan dokumen serah terima; sekretaris umum berwenang menagih laporan kegiatan setiap kementerian.

Bendahara Umum mengelola anggaran, pencairan dana fakultas, dan laporan keuangan semesteran; setiap pengeluaran wajib disetujui bendahara umum.

Kepala Kementerian memimpin program kerja di bidangnya. Ada enam kementerian: Advokasi dan Kesejahteraan Mahasiswa, Komunikasi dan Informasi, Pengembangan Sumber Daya Mahasiswa, Riset dan Inovasi Teknologi, Hubungan Luar dan Kemitraan, serta Sosial Masyarakat.

Sekretaris Kementerian membantu kepala kementerian dalam administrasi dan pelaporan program di kementeriannya.

Staf kementerian menjalankan program kerja sehari-hari dan tidak berwenang mengambil keputusan anggaran.

Hubungan kerja bersifat instruktif dari Ketua BEM kepada Kepala Kementerian, lalu kepada Sekretaris Kementerian dan staf.`,
  },

  "Pihak eksternal": {
    filename: "DUMMY Pihak eksternal BEM FTEIC.txt",
    text: `DATA DUMMY untuk uji coba — Pihak di luar kepengurusan yang berhubungan dengan BEM FTEIC

Wakil Dekan bidang kemahasiswaan menentukan alokasi dana kegiatan BEM, menyetujui proposal, dan memantau laporan pertanggungjawaban.

Dosen pembina mendampingi kegiatan BEM dan menjadi penghubung dengan pimpinan fakultas.

BEM ITS mengoordinasikan agenda organisasi kemahasiswaan tingkat institut dan dapat meminta BEM fakultas menyesuaikan program.

Dewan Perwakilan Mahasiswa (DPM) FTEIC mengawasi kinerja dan keuangan BEM FTEIC serta berhak meminta laporan pertanggungjawaban.

Himpunan mahasiswa departemen (HMD) menyelenggarakan kegiatan di tiap departemen dan perlu diajak berkoordinasi agar jadwal tidak bentrok.

Direktorat Kemahasiswaan ITS menetapkan aturan pelaporan kegiatan organisasi kemahasiswaan tingkat institut.

Alumni FTEIC yang bekerja di industri bersedia menjadi pemateri dan membuka jejaring magang, tetapi keterlibatannya belum rutin.

Perusahaan teknologi calon sponsor tertarik mendukung pelatihan bersertifikat bila proposal diajukan jauh hari.`,
  },
};

export type CustomPatch = {
  prefix: string;
  instruction: string;
  format: "list" | "table";
  columns?: string[];
  requireEvidence: boolean;
};

/** Instruksi node proses kustom; kunci = nama node di canvas (huruf besar/kecil diabaikan). */
export const BEM_CUSTOM: Record<string, CustomPatch> = {
  "LATAR BELAKANG": {
    prefix: "LB",
    format: "table",
    columns: ["Jenis (Keresahan / Ambisi / Harapan)", "Pernyataan", "Mengapa penting bagi BEM FTEIC"],
    requireEvidence: true,
    instruction: `Susun LATAR BELAKANG penyusunan grand design BEM FTEIC ITS dari tiga sumber yang tersambung ke node ini: dokumen KERESAHAN (masalah yang dirasakan mahasiswa dan pengurus), AMBISI (cita-cita kepengurusan), dan HARAPAN (harapan mahasiswa, dosen pembina, pimpinan fakultas, himpunan, alumni).

Cara mengerjakan:
1. Setiap baris tabel memuat SATU keresahan, ambisi, atau harapan yang konkret. Kolom "Jenis" diisi tepat salah satu: Keresahan, Ambisi, atau Harapan.
2. Kolom "Pernyataan" menuliskan isinya dengan kata-kata ringkas; kolom "Mengapa penting" menjelaskan dampaknya bagi BEM FTEIC dalam satu kalimat, tanpa menambah fakta yang tidak ada di dokumen.
3. Pilih butir yang paling kuat dan jangan menduplikasi: kira-kira 5–6 keresahan, 4–5 ambisi, 4–5 harapan. Utamakan keresahan yang punya pasangan ambisi atau harapan.
4. Setiap baris wajib berkutipan persis dari dokumen sumber yang sesuai.
5. Pada "summary", tulis 3–4 kalimat rumusan latar belakang yang mengalir: keresahan utama → ambisi → harapan → alasan BEM FTEIC perlu grand design.`,
  },

  "KONDISI IDEAL ORGANISASI": {
    prefix: "KI",
    format: "table",
    columns: ["Dimensi", "Kondisi ideal", "Indikator terukur", "Dasar (AD/ART atau referensi)"],
    requireEvidence: true,
    instruction: `Rumuskan KONDISI IDEAL BEM FTEIC sebagai patokan untuk analisis kesenjangan. Gunakan HANYA dua sumber yang tersambung ke node ini: dokumen NILAI ORGANISASI (AD/ART) dan JURNAL/REFERENSI. Jangan memakai data keresahan, survei, atau notulensi, karena itu adalah kondisi saat ini.

Cara mengerjakan:
1. Susun 6 dimensi, satu baris per dimensi: Tata kelola dan dokumentasi; Kaderisasi dan SDM; Program dan dampak; Komunikasi dan aspirasi; Kemitraan dan pendanaan; Transparansi dan akuntabilitas.
2. "Kondisi ideal" adalah gambaran keadaan yang diinginkan pada dimensi itu, satu atau dua kalimat.
3. "Indikator terukur" WAJIB memuat angka, persentase, atau jumlah yang bisa dicek (mis. "100 persen program punya laporan dan arsip serah terima"). Jika dokumen tidak memberi angka, usulkan angka yang wajar dan tandai dengan kata "usulan".
4. "Dasar" berisi pasal AD/ART atau nomor referensi yang menjadi pijakan, dan setiap baris wajib berkutipan persis dari salah satu dua dokumen itu.
5. Di "summary", jelaskan dalam 2–3 kalimat gambaran umum BEM FTEIC yang ideal menurut sumber tersebut.`,
  },

  "GAP ANALYSIS": {
    prefix: "GP",
    format: "table",
    columns: ["Dimensi", "Kondisi ideal", "Kondisi saat ini", "Kesenjangan", "Prioritas (Tinggi / Sedang / Rendah)", "Faktor S/W/O/T terkait"],
    requireEvidence: false,
    instruction: `Lakukan GAP ANALYSIS: bandingkan KONDISI IDEAL ORGANISASI dengan kondisi BEM FTEIC saat ini yang tergambar pada hasil "Faktor internal (S+W)" (kekuatan dan kelemahan) dan "Faktor eksternal (O+T)" (peluang dan ancaman). Ketiganya tersambung ke node ini.

Cara mengerjakan:
1. Satu baris untuk setiap dimensi pada KONDISI IDEAL. Salin nama dimensi dan ringkasan kondisi idealnya.
2. "Kondisi saat ini" dirangkum dari faktor yang relevan (utamakan kekuatan S dan kelemahan W). Sebut ID faktornya di kolom "Faktor S/W/O/T terkait" (mis. W2, S1, T1).
3. "Kesenjangan" menyatakan selisih antara ideal dan saat ini, sebisa mungkin bersifat angka (mis. "ideal 100 persen, saat ini 56 persen berlaporan lengkap"), berdasarkan indikator pada KONDISI IDEAL dan angka yang ada di faktor.
4. "Prioritas" diisi tepat Tinggi, Sedang, atau Rendah: Tinggi bila kesenjangan besar DAN berkaitan dengan kelemahan atau ancaman yang bobotnya besar.
5. Isi "refs" dengan ID butir KONDISI IDEAL (mis. KI2) dan ID faktor yang dipakai pada baris itu. Jangan memakai ID yang tidak ada.
6. Di "summary", sebutkan 3 kesenjangan berprioritas tertinggi sebagai bahan perumusan strategi di matriks SWOT.`,
  },
};
