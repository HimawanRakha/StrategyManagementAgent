import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Menjalankan file drizzle/*.sql secara berurutan dan mencatatnya di _migrations.
 * Dimensi vector(768) di SQL diganti otomatis sesuai EMBEDDING_DIM.
 */
export async function runMigrations(
  exec: (sql: string) => Promise<unknown>,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
  dir = path.join(process.cwd(), "drizzle"),
) {
  await exec(`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await query(`SELECT name FROM _migrations`)).map((r) => String(r.name)));
  const dim = Number(process.env.EMBEDDING_DIM ?? 768);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const text = readFileSync(path.join(dir, f), "utf8").replace(/vector\(768\)/g, `vector(${dim})`);
    await exec(text);
    await exec(`INSERT INTO _migrations (name) VALUES ('${f.replace(/'/g, "''")}')`);
    ran.push(f);
  }
  return ran;
}
