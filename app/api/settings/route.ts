import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { handle } from "@/lib/access";
import { requireResearcher } from "@/lib/researcher";
import { getSetting } from "@/lib/experiment/parameters";
import { DEFAULT_CODEBOOK } from "@/lib/codebook";
import { defaultModel, llmProvider } from "@/lib/llm/provider";
import { passwordRequired } from "@/lib/session";
import { queueBackend } from "@/lib/engine/queue";

export const GET = handle(async () => {
  await requireResearcher();
  return {
    settings: {
      model: await getSetting<string>("model", ""),
      temperature: await getSetting<number>("temperature", Number(process.env.LLM_TEMPERATURE ?? 0.2)),
      dh: await getSetting<number>("dh", 0.85),
      codebook: await getSetting("codebook", DEFAULT_CODEBOOK),
    },
    // Hanya status konfigurasi; nilai API key tidak pernah dikirim ke browser.
    env: {
      provider: llmProvider(),
      defaultModel: defaultModel(),
      embeddingModel: process.env.EMBEDDING_MODEL || "gemini-embedding-001",
      embeddingDim: Number(process.env.EMBEDDING_DIM ?? 768),
      maxRepair: Number(process.env.MAX_REPAIR_ATTEMPTS ?? 2),
      geminiKey: !!process.env.GEMINI_API_KEY,
      groqKey: !!process.env.GROQ_API_KEY,
      database: !process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith("pglite:") ? "PGlite lokal" : process.env.DATABASE_URL.includes("neon.tech") ? "Neon" : "Postgres",
      auth: passwordRequired(),
      queue: queueBackend(),
    },
  };
});

const Body = z.object({
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  dh: z.number().min(0).max(1).optional(),
  codebook: z.object({ version: z.string().min(1), text: z.string().min(10) }).optional(),
});

export const PUT = handle(async (req: Request) => {
  await requireResearcher();
  const body = Body.parse(await req.json());
  const db = await getDb();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    await db
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  }
  return { ok: true };
});
