import "server-only";
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { callLlm } from "@/lib/llm/provider";
import type { LlmSession } from "@/lib/nodes/types";

export class FormatError extends Error {}

/** Simpan keterangan terkini node (ditampilkan di daftar run & canvas). */
async function notice(nodeRunId: string, message: string) {
  try {
    const db = await getDb();
    await db.update(schema.nodeRuns).set({ notice: message.slice(0, 500), noticeAt: new Date() }).where(eq(schema.nodeRuns.id, nodeRunId));
  } catch {
    /* keterangan bersifat tambahan */
  }
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error("Bukan JSON");
  }
}

/**
 * Sesi LLM untuk satu node run: setiap panggilan dicatat ke llm_calls (token, waktu, tujuan).
 * Output divalidasi Zod; kegagalan format diberi satu kali percobaan ulang dan dicatat terpisah
 * dari galat isi (format_error + node_runs.format_failures).
 */
export function createLlmSession(opts: {
  nodeRunId: string;
  injectionId?: string;
  model?: string;
  temperature?: number;
}): LlmSession {
  return {
    async json<T>(purpose: "generate" | "validate" | "repair" | "judge", system: string, user: string, zschema: z.ZodType<T>, mock: () => T) {
      const db = await getDb();
      let prompt = user;
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await callLlm(system, prompt, { model: opts.model, temperature: opts.temperature, mock, onNotice: (m) => void notice(opts.nodeRunId, m) });
        let parsed: z.ZodSafeParseResult<T> | null = null;
        let err = "";
        try {
          parsed = zschema.safeParse(parseJson(r.text));
          if (!parsed.success) err = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        } catch (e) {
          err = (e as Error).message;
        }
        const ok = !!parsed?.success;
        await db.insert(schema.llmCalls).values({
          nodeRunId: opts.nodeRunId,
          injectionId: opts.injectionId ?? null,
          purpose,
          model: r.model,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          latencyMs: r.latencyMs,
          formatError: !ok,
        });
        if (ok) return parsed!.data as T;
        await db
          .update(schema.nodeRuns)
          .set({ formatFailures: sql`${schema.nodeRuns.formatFailures} + 1` })
          .where(eq(schema.nodeRuns.id, opts.nodeRunId));
        prompt = `${user}\n\nPERCOBAAN SEBELUMNYA DITOLAK karena format JSON tidak sesuai skema: ${err}\nBalas ulang HANYA dengan JSON yang valid.`;
      }
      throw new FormatError("Output LLM bukan JSON yang valid menurut skema (setelah satu kali percobaan ulang)");
    },
  };
}
