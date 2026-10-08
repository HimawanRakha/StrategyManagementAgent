# Strategi Agen — Platform Eksperimen Alur Agen LLM untuk Perencanaan Strategis

Implementasi dari *Brief Teknis Platform Eksperimen Alur Agen LLM untuk Perencanaan Strategis*.
Platform ini menjalankan alur penyusunan grand design organisasi dari audit sampai strategi fungsional
dengan agen LLM per node. Setiap tahap dicatat galat dan biayanya, penempatan validasi terbaik dihitung,
lalu dokumen grand design bersitasi disusun.

Stack: Next.js 16 (App Router, TypeScript, Tailwind v4) · Neon Postgres + pgvector (Drizzle) · Gemini/Groq ·
Zod · React Flow · Recharts · Upstash QStash · docx · @react-pdf/renderer.

## Mulai cepat (lokal, tanpa API key dan tanpa Neon)

```bash
npm install
cp .env.example .env.local      # bawaan: LLM_PROVIDER=mock, DATABASE_URL=pglite:./.data/pglite
npm run db:migrate              # membuat skema di PGlite (Postgres tertanam + pgvector)
npm run db:seed                 # kasus sintetis contoh + dua alur bawaan
npm run dev                     # http://localhost:3000
```

## Cara pakai

1. **Proyek baru.** Isi nama organisasi, lalu kamu langsung masuk ke **canvas alur berpikir** (kosong).
2. **Tarik elemen dari daftar di kiri** ke canvas:
   - **Input** (jajar genjang): klik untuk mengunggah notulensi, LPJ, survei, dan dokumen lain.
   - **Proses** (persegi panjang): satu analisis per tab Excel framework, dikelompokkan ES (stakeholder, faktor S+W/O+T, IFAS, EFAS), SGS (posisi organisasi, matriks SWOT, QSPM, cascading), SI (kontinuitas proker), LTV (renstra), MSDM (7 tab), DM-CRM (decision, change, risk).
   - **Output** (bentuk dokumen): menyusun grand design dan mengekspor **XLSX** (satu sheet per tab, rumus Excel tetap hidup), DOCX, atau PDF.
3. **Klik node proses → Jalankan.** Analisis sebelumnya yang dibutuhkan ikut dijalankan otomatis.
   Hasil tampil sebagai **sheet ala Excel**: klik sel untuk melihat rumus, penjelasan, dan alasan AI.
   **Bobot dihitung dengan AHP** dari perbandingan berpasangan yang diusulkan AI; angka lain (rating, AS, skor, P×I)
   diusulkan AI. Semua bisa diubah lewat **Ubah angka/isi**; analisis sesudahnya dihitung ulang otomatis dan perubahan dicatat.

4. **Buat proses sendiri** (node kustom): beri nama dan instruksi, misalnya "Analisis risiko". Analisis yang panahnya
   masuk menjadi bahan bacaannya, dan hasilnya tetap berupa butir dengan kutipan dokumen.
5. **Pemeriksaan terlihat di canvas.** Tarik panah dari node proses ke elemen:
   - **Validator otomatis** (segi enam): hasil diperiksa dan diperbaiki otomatis.
   - **Tinjauan manusia** (belah ketupat): run berhenti sampai kamu setujui.
   Penempatan kedua elemen ini adalah variabel optimasi penelitian.
6. **Pengaturan tiap node**: nama, catatan/instruksi tambahan untuk AI, fokus pencarian dokumen, jumlah bukti,
   kreativitas, model, serta pemeriksaan mana yang aktif (di elemen validator).
7. **Laporan** di canvas: cara membaca, semua galat dan temuan, rumus, angka yang dipakai model optimasi
   beserta sumbernya, **rekomendasi** letak validator/tinjauan (tombol "Terapkan ke canvas"), dan kesimpulan.
8. **Ulang dari awal**: hasil run diarsipkan (tetap jadi data eksperimen) dan canvas mulai dari awal.

Saat run berjalan, node yang sedang dikerjakan beranimasi dan menampilkan tahapnya
(mengambil bukti → menulis → memeriksa → memperbaiki), lengkap dengan bar progres.

Ingin langsung mencoba? Pilih **Coba contoh** di halaman Proyek untuk membuat kasus sintetis dengan canvas lengkap.

Satu kata sandi bersama (`APP_PASSWORD`) dipakai seluruh tim, tanpa peran. Bila kosong, tidak ada login
(hanya cocok untuk lokal). **Eksperimen** (menu terpisah) berisi modul penelitian TA: run batch, anotasi
buta dengan nama penilai, putusan, parameter, penyuntikan galat, optimasi, dan simulasi.

`LLM_PROVIDER=mock` menghasilkan output deterministik dari heuristik kata kunci. Mode ini cukup untuk
menguji seluruh alur, validator, penyuntikan galat, dan UI. **Hasil mock bukan analisis sungguhan.**

## Mengaktifkan AI (Gemini) — langkah singkat

1. Buat key di <https://aistudio.google.com/apikey> (login Google → *Create API key*).
2. Buka `.env.local`, isi `GEMINI_API_KEY=<tempel key>` (tanpa spasi atau tanda kutip). Jangan kirim key ke chat dan jangan di-commit.
3. Hentikan lalu jalankan ulang server (`npm run dev`). Bawaan `LLM_PROVIDER=auto` otomatis memakai Gemini begitu key terisi.
4. Periksa: `npm run llm:check` menguji pembuatan teks dan embedding, serta menampilkan daftar model bila gagal.
5. Dokumen yang diunggah saat mode uji otomatis dihitung ulang embeddingnya saat run pertama dengan Gemini.

Model bawaan memakai alias `gemini-flash-latest` (Flash stabil terbaru). Untuk eksperimen TA, patok versi lewat `LLM_MODEL`.
Di paket gratis, `LLM_MIN_INTERVAL_MS=3000` memberi jeda antar-panggilan agar tidak kena batas laju.

**Dokumen mana yang dibaca sebuah analisis?** Bila ada node Input yang panahnya masuk ke node itu, hanya dokumen dari
input tersebut yang dibaca (panah di canvas = sumber bacaan). Tanpa input tersambung, node membaca semua dokumen proyek.
Bisa diganti per node di *Pengaturan node → Dokumen yang dibaca*.

Data dummy BEM FTEIC ITS (untuk uji coba): `npm run seed:bem` mengisi dokumen dummy di setiap node input dan instruksi
node kustom (`lib/seed/bem-fteic.ts`). Ganti dokumen dummy dengan dokumen asli yang sudah dianonimkan sebelum dipakai sungguhan.

## Memakai Neon + Gemini (sesuai brief)

1. Buat database di [Neon](https://neon.tech), lalu salin connection string ke `DATABASE_URL`.
2. Isi `.env.local`: `LLM_PROVIDER=gemini`, `GEMINI_API_KEY=...`, `LLM_MODEL=<nama model dari dokumentasi Gemini>`.
   Embedding memakai `EMBEDDING_MODEL` (bawaan `gemini-embedding-001`) dengan `EMBEDDING_DIM=768`.
   Groq bisa dipakai untuk generasi (`LLM_PROVIDER=groq`, `GROQ_API_KEY`), tetapi embedding tetap
   lewat Gemini karena Groq tidak menyediakan API embedding.
3. `npm run db:migrate`. Cara lain: tempel `drizzle/0000_init.sql` ke SQL Editor Neon.
   Samakan `EMBEDDING_DIM` sebelum migrasi pertama.
4. Punya data di PGlite lokal? Hentikan server lalu jalankan `npm run db:copy` untuk menyalin semua data
   (proyek, dokumen + embedding, run, edit, tinjauan, log AI) ke database `DATABASE_URL`. Aman dijalankan ulang.
5. Untuk paket gratis, set `LLM_MIN_INTERVAL_MS` (mis. 4000) agar tidak terkena rate limit.

Aturan pengamanan dari brief sudah diterapkan:

- Tidak ada key berawalan `NEXT_PUBLIC_`.
- LLM hanya dipanggil dari API route.
- `lib/llm/provider.ts` diawali `import "server-only"`.
- `.env.local` masuk `.gitignore`.

Anonimkan nama orang di dokumen dan cek ketentuan data penyedia sebelum mengunggah dokumen organisasi.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Server pengembangan |
| `npm run db:migrate` | Menjalankan `drizzle/*.sql` ke `DATABASE_URL` (Neon/Postgres) atau PGlite |
| `npm run db:seed` | Membuat kasus sintetis contoh |
| `npm test` | Unit test kalkulator, kappa, Wilson, estimasi e, optimasi (brute force = DP), simulasi, validator |
| `npm run smoke` | Uji asap end-to-end (mode mock): rantai ES+SGS → penyuntikan galat → parameter → optimasi → ekspor |
| `npm run seed:bem` | Proyek BEM FTEIC ITS: migrasi canvas lama ke node baru + dokumen dummy + instruksi node kustom |
| `npm run typecheck` | Pemeriksaan TypeScript |

## Peta fitur terhadap brief

| Brief | Lokasi |
|---|---|
| Skema database (data kasus, eksekusi, eksperimen, fase 2–3) | `drizzle/0000_init.sql`, `lib/db/schema.ts` |
| Pembungkus LLM yang mencatat biaya | `lib/llm/provider.ts`, `lib/engine/llm-session.ts` (tabel `llm_calls`) |
| Unggah → chunking 800/100 → embedding → pencarian vektor | `lib/rag/*`, `POST /api/documents` |
| 22 node per tab Excel + kontrak JSON Zod | `lib/nodes/{es,sgs,si,ltv,msdm,dmcrm}/*.ts`, `lib/nodes/contracts.ts`, `lib/nodes/registry.ts` |
| Sheet ala Excel, AHP, edit manusia | `lib/sheets/*`, `lib/calc/ahp.ts`, `lib/engine/edit.ts`, `PATCH /api/node-runs/[id]/output` |
| Validator (kode + LLM) per node | `lib/validators/*.ts` |
| Kalkulator (dalam `compute` tiap node, sama dengan rumus Excel; uji emas di `tests/nodes-*.test.ts`) | `lib/nodes/**`, `lib/calc/*.ts` |
| Engine: topologis, satu node / sampai node / otomatis | `lib/engine/*.ts`, `/api/runs/[id]/execute`, `/api/runs/[id]/start`, `/api/jobs/step` |
| Pertanyaan agen ke pengguna (bukti "U…") | `agent_questions`, `/api/agent-questions/[id]/answer` |
| Anotasi buta, kappa, putusan | `/experiments` (tab Anotasi, Putusan), `/api/annotate/next`, `/api/annotations`, `/api/verdicts` |
| Penyuntikan galat (d, r) | `lib/experiment/injectors.ts`, `run-injection.ts`, `/api/injections` |
| e, d, r, h, biaya, Wilson | `lib/experiment/parameters.ts`, `/api/experiments/parameters` |
| Propagasi, optimize, optimizeDP, Markov, Monte Carlo | `lib/experiment/{propagation,optimize,simulate}.ts` |
| Kurva kualitas vs. anggaran | `/experiments`, `/api/experiments/optimize` |
| Grand design + ekspor XLSX/DOCX/PDF + `trace_complete` | `lib/grand-design/*`, `lib/export/*`, node Output di canvas |
| Canvas input/proses/output | `lib/engine/canvas.ts`, `lib/engine/main-run.ts`, `/projects/[id]`, `/api/projects/[id]/{canvas,run,output}` |
| Akses satu kata sandi | `lib/session.ts`, `lib/access.ts`, `proxy.ts` |

## Keputusan dan tambahan di luar brief

- **Kegagalan format JSON bukan galat tahap.** Brief meminta keputusan ini sebelum minggu 5.
  Kegagalan format dicatat terpisah (`llm_calls.format_error`, `node_runs.format_failures`) dan diberi
  satu kali percobaan ulang.
- **PGlite dan mock LLM** membuat platform bisa dijalankan tanpa layanan luar. Neon tetap dipakai untuk
  produksi. Driver dipilih otomatis dari `DATABASE_URL`.
- **Antrean lokal**: tanpa `QSTASH_TOKEN`, mode otomatis menjalankan job di proses server yang sama.
  Di Vercel, isi kredensial QStash dan `APP_URL`.
- **Kolom tambahan**:
  - `chunks.label` (ID sitasi C1, C2, … unik per proyek)
  - `chunks.project_id`
  - `documents.is_values` (dokumen nilai organisasi untuk visi-misi)
  - `node_runs.validation_passed`, `format_failures`, `error`
  - `llm_calls.injection_id`/`model`, sehingga biaya uji penyuntikan tidak tercampur ke c_i^v
  - `injections.node_run_id`/`item_id`/`repaired_output`
  - `agent_questions.label`/`project_id`
  - tabel `settings`
  - `documents.input_node` (node input canvas); tabel Auth.js dan `project_members` dihapus (`drizzle/0001_simplify.sql`)
- **Satu akun, tanpa peran** (permintaan pengguna). Brief merencanakan Auth.js dengan peran; diganti
  satu kata sandi bersama. Penilai anotasi dibedakan lewat nama, sehingga kappa dua penilai tetap terhitung.
- **Urutan eksekusi = dependensi wajib + panah antar-analisis**: dependensi wajib tetap berlaku walau panahnya belum
  digambar; panah tambahan menjadi konteks bagi analisis berikutnya. Panah ke node Output menentukan bab apa saja yang masuk dokumen.
- **Output mentah AI disimpan terpisah** (`node_runs.raw`, `edits`, `edited_at` — `drizzle/0003_edits.sql`) agar pengguna bisa
  mengubah angka; run yang diarsipkan diberi tag `arsip` (`runs.archived_at`).
- **Node kustom dan elemen pemeriksaan** (`lib/nodes/custom.ts`, `lib/engine/resolve.ts`): penempatan validator/tinjauan
  ditentukan elemen yang tersambung di canvas, bukan sakelar tersembunyi. Pengaturan node (catatan, fokus, jumlah bukti,
  temperature, model, pemeriksaan yang dimatikan, batas perbaikan) dipakai saat node dijalankan. Kolom `node_runs.phase`
  (`drizzle/0002_phase.sql`) mencatat tahap berjalan untuk animasi.
- **Setiap analisis membaca seluruh dokumen proyek**; node Input mengelompokkan dokumen di canvas.
- Hasil AI selalu diberi label **DRAF** dan wajib ditelaah sebelum dipakai.
- **Estimasi e_i** hanya memakai node run tanpa validator/tinjauan (galat mentah) yang inputnya bersih
  menurut putusan. Estimasi h_i (pemulihan) memakai run yang inputnya salah.

## Deploy (Vercel + Neon)

Isi Environment Variables di Vercel dengan nilai yang sama seperti `.env.local`, **termasuk `APP_PASSWORD` dan `AUTH_SECRET`**. Untuk mode otomatis,
isi juga `QSTASH_*` dan `APP_URL`. Setiap request menjalankan satu node (`maxDuration = 60`) agar tidak
terkena batas waktu fungsi serverless.
