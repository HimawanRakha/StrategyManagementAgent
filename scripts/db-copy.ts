// npm run db:copy [-- <folder PGlite sumber>] — salin SEMUA data dari PGlite lokal (bawaan ./.data/pglite) ke DATABASE_URL
// (Neon/Postgres): proyek, canvas, dokumen + embedding, run, hasil node, edit, tinjauan, log AI, anotasi, dst.
// Skema tujuan dibuat dulu lewat migrasi. Baris yang sudah ada di tujuan (ID sama) dilewati, jadi aman dijalankan ulang.
// Hentikan server dev dulu: PGlite hanya bisa dibuka satu proses.
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { runMigrations } from "../lib/db/migrate";

const BATCH = 200;
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || url.startsWith("pglite:")) throw new Error("DATABASE_URL di .env.local belum berisi database tujuan (Neon/Postgres).");
  const srcDir = process.argv[2] ?? "./.data/pglite";

  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const src = new PGlite(srcDir, { extensions: { vector } });
  const { Client } = await import("pg");
  const dst = new Client({ connectionString: url });
  await dst.connect();

  console.log("1. Membuat/memperbarui tabel di database tujuan…");
  const ran = await runMigrations((s) => dst.query(s), async (s) => (await dst.query(s)).rows);
  console.log(ran.length ? `   migrasi: ${ran.join(", ")}` : "   sudah mutakhir");

  // Urutan tabel mengikuti foreign key (induk lebih dulu).
  const tables = (
    await src.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_migrations'`)
  ).rows.map((r) => r.t);
  const fks = (
    await src.query<{ child: string; parent: string }>(`SELECT tc.table_name AS child, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`)
  ).rows;
  const order: string[] = [];
  const visit = (t: string, path: string[] = []) => {
    if (order.includes(t) || path.includes(t)) return;
    for (const f of fks.filter((x) => x.child === t && x.parent !== t)) visit(f.parent, [...path, t]);
    order.push(t);
  };
  tables.forEach((t) => visit(t));

  console.log("2. Menyalin data…");
  let total = 0;
  for (const t of order) {
    const { rows } = await src.query<{ j: Record<string, unknown> }>(`SELECT row_to_json(x) AS j FROM ${q(t)} x`);
    let copied = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).map((r) => r.j);
      const res = await dst.query(
        `INSERT INTO ${q(t)} SELECT * FROM json_populate_recordset(NULL::${q(t)}, $1::json) ON CONFLICT DO NOTHING`,
        [JSON.stringify(chunk)],
      );
      copied += res.rowCount ?? 0;
    }
    total += copied;
    console.log(`   ${t.padEnd(24)} ${String(rows.length).padStart(6)} baris di sumber, ${copied} baru disalin`);
  }

  console.log("3. Memeriksa jumlah baris…");
  let ok = true;
  for (const t of order) {
    const a = Number((await src.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n);
    const b = Number((await dst.query(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n);
    if (b < a) {
      ok = false;
      console.log(`   ✗ ${t}: sumber ${a}, tujuan ${b}`);
    }
  }
  console.log(ok ? `Selesai: ${total} baris disalin; semua tabel di tujuan sudah lengkap.` : "Ada tabel yang belum lengkap — lihat di atas.");
  await src.close();
  await dst.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
