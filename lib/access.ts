import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db/client";
import { SESSION_COOKIE, isValidSession } from "@/lib/session";

// Satu akun bersama: tidak ada peran. Setiap route cukup memastikan sesi (kata sandi) valid.

export type CurrentUser = { id: string; name: string };
export const TEAM_USER: CurrentUser = { id: "tim", name: "Tim" };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function currentUser(): Promise<CurrentUser | null> {
  const ok = await isValidSession((await cookies()).get(SESSION_COOKIE)?.value);
  return ok ? TEAM_USER : null;
}

export async function requireUser() {
  const u = await currentUser();
  if (!u) throw new HttpError(401, "Silakan masuk dengan kata sandi terlebih dahulu");
  return u;
}

/** Pastikan sesi valid dan proyek ada. */
export async function requireProject(projectId: string) {
  const user = await requireUser();
  const db = await getDb();
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) throw new HttpError(404, "Proyek tidak ditemukan");
  return { user };
}

export async function projectOfWorkflow(workflowId: string) {
  const db = await getDb();
  const [w] = await db.select({ projectId: schema.workflows.projectId }).from(schema.workflows).where(eq(schema.workflows.id, workflowId));
  if (!w) throw new HttpError(404, "Alur tidak ditemukan");
  return w.projectId;
}

export async function projectOfRun(runId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ projectId: schema.workflows.projectId })
    .from(schema.runs)
    .innerJoin(schema.workflows, eq(schema.workflows.id, schema.runs.workflowId))
    .where(eq(schema.runs.id, runId));
  if (!r) throw new HttpError(404, "Run tidak ditemukan");
  return r.projectId;
}

export async function projectOfNodeRun(nodeRunId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ projectId: schema.workflows.projectId })
    .from(schema.nodeRuns)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.nodeRuns.runId))
    .innerJoin(schema.workflows, eq(schema.workflows.id, schema.runs.workflowId))
    .where(eq(schema.nodeRuns.id, nodeRunId));
  if (!r) throw new HttpError(404, "Node run tidak ditemukan");
  return r.projectId;
}

/** Pembungkus route handler: ubah galat menjadi respons JSON. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response | unknown>) {
  return async (...args: A): Promise<Response> => {
    try {
      const res = await fn(...args);
      return res instanceof Response ? res : NextResponse.json(res ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e as { name?: string })?.name === "ZodError" ? 400 : 500;
      if (status === 500) console.error(e);
      return NextResponse.json({ error: (e as Error).message }, { status });
    }
  };
}
