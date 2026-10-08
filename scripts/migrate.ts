// npm run db:migrate — menjalankan drizzle/*.sql ke DATABASE_URL (Neon/Postgres) atau PGlite lokal.
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { runMigrations } from "../lib/db/migrate";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const dir = url?.replace(/^pglite:/, "") || "./.data/pglite";
    (await import("node:fs")).mkdirSync(dir, { recursive: true });
    const pg = new PGlite(dir, { extensions: { vector } });
    const ran = await runMigrations((q) => pg.exec(q), async (q) => (await pg.query(q)).rows as Record<string, unknown>[]);
    console.log(ran.length ? `Migrasi dijalankan (PGlite): ${ran.join(", ")}` : "PGlite sudah mutakhir.");
    await pg.close();
    return;
  }
  // Neon juga menerima koneksi TCP biasa, jadi pg dipakai untuk SQL multi-statement.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  const ran = await runMigrations((q) => client.query(q), async (q) => (await client.query(q)).rows);
  console.log(ran.length ? `Migrasi dijalankan: ${ran.join(", ")}` : "Database sudah mutakhir.");
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
