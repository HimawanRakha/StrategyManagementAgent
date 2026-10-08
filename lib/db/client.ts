import "server-only";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema";
import { runMigrations } from "./migrate";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Tiga driver:
//  - Neon (produksi, sesuai brief): DATABASE_URL berisi neon.tech, atau DB_DRIVER=neon
//  - PGlite (pengembangan lokal tanpa server): DATABASE_URL kosong atau diawali "pglite:"
//  - node-postgres: Postgres biasa (mis. Docker lokal)
type Driver = "neon" | "pglite" | "pg";

function pickDriver(url: string | undefined): Driver {
  if (process.env.DB_DRIVER) return process.env.DB_DRIVER as Driver;
  if (!url || url.startsWith("pglite:")) return "pglite";
  if (url.includes("neon.tech")) return "neon";
  return "pg";
}

const g = globalThis as unknown as { __db?: Promise<Db> };

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  const driver = pickDriver(url);
  if (driver === "neon") {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    return drizzle(neon(url!), { schema }) as unknown as Db;
  }
  if (driver === "pg") {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    return drizzle(new Pool({ connectionString: url }), { schema }) as unknown as Db;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dataDir = url?.replace(/^pglite:/, "") || "./.data/pglite";
  (await import("node:fs")).mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir, { extensions: { vector } });
  await runMigrations((q) => client.exec(q), async (q) => (await client.query(q)).rows as Record<string, unknown>[]);
  return drizzle(client, { schema }) as unknown as Db;
}

export function getDb(): Promise<Db> {
  if (!g.__db) {
    g.__db = connect().catch((e) => {
      g.__db = undefined;
      throw e;
    });
  }
  return g.__db;
}

/** Jalankan SQL mentah dan kembalikan baris; seragam untuk ketiga driver. */
export async function queryRows<T = Record<string, unknown>>(query: SQL): Promise<T[]> {
  const db = await getDb();
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

export { schema };
