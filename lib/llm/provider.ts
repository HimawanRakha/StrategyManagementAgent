import "server-only";
import { mockEmbedding } from "./mock-embedding";

export type LlmProvider = "gemini" | "groq" | "mock";
export type LlmResult = { text: string; tokensIn: number; tokensOut: number; latencyMs: number; model: string };
export type CallOptions = {
  model?: string;
  temperature?: number;
  /** Dipakai hanya bila LLM_PROVIDER=mock: menghasilkan objek yang akan dikembalikan sebagai JSON. */
  mock?: () => unknown;
  /** Dipanggil saat menunggu/coba ulang/pindah model — keterangan untuk pengguna. */
  onNotice?: (message: string) => void;
};

/**
 * LLM_PROVIDER = gemini | groq | mock | auto (bawaan).
 * auto: pakai Gemini bila GEMINI_API_KEY terisi, lalu Groq bila GROQ_API_KEY terisi, selain itu mode uji (mock).
 */
export function llmProvider(): LlmProvider {
  const p = (process.env.LLM_PROVIDER ?? "auto").trim().toLowerCase();
  if (p === "gemini" || p === "groq" || p === "mock") return p;
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";
  if (process.env.GROQ_API_KEY?.trim()) return "groq";
  return "mock";
}

/**
 * Model bawaan Gemini memakai alias "gemini-flash-latest" (selalu menunjuk Flash stabil terbaru), karena nama model
 * yang dipatok bisa dibatasi/dimatikan Google (mis. seri 2.x). Untuk eksperimen TA, patok versi lewat LLM_MODEL
 * (jalankan `npm run llm:check` untuk melihat daftar model yang tersedia untuk key Anda).
 */
export function defaultModel(): string {
  const p = llmProvider();
  if (p === "mock") return "mock";
  return process.env.LLM_MODEL?.trim() || (p === "gemini" ? "gemini-flash-latest" : "llama-3.3-70b-versatile");
}

/** Model cadangan Gemini bila model utama padat. Bawaan: Flash-Lite terbaru; "none" mematikan. */
function fallbackModel(primary: string): string | null {
  if (llmProvider() !== "gemini") return null;
  const fb = (process.env.LLM_FALLBACK_MODEL ?? "gemini-flash-lite-latest").trim();
  return !fb || fb.toLowerCase() === "none" || fb === primary ? null : fb;
}

/** Penanda cara embedding yang dipakai; potongan dokumen dengan penanda berbeda dihitung ulang otomatis saat dipakai. */
export function embedderId(): string {
  const mock = llmProvider() === "mock" || process.env.EMBEDDING_PROVIDER === "mock";
  return mock ? `mock:${EMBEDDING_DIM}` : `gemini:${process.env.EMBEDDING_MODEL || "gemini-embedding-001"}:${EMBEDDING_DIM}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

/** Jeda minimum antar-panggilan agar tidak menabrak rate limit paket gratis. */
async function throttle() {
  const gap = Number(process.env.LLM_MIN_INTERVAL_MS ?? 0);
  const wait = Math.min(lastCallAt + gap - Date.now(), gap); // dibatasi `gap` agar jam sistem yang mundur tidak membuat menunggu lama
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

// ===== Galat penyedia: dikelompokkan agar hanya galat sementara yang dicoba ulang =====
type ErrKind = "busy" | "quota" | "auth" | "model" | "other";

export class LlmError extends Error {
  constructor(
    message: string,
    public kind: ErrKind,
  ) {
    super(message);
  }
}

function errInfo(e: unknown) {
  const raw = String((e as Error)?.message ?? e);
  let code = Number((e as { status?: number })?.status) || 0;
  let status = "";
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{")));
    code = Number(j?.error?.code) || code;
    status = String(j?.error?.status ?? "");
  } catch {
    /* pesan bukan JSON */
  }
  return { raw, code, status, text: `${code} ${status} ${raw}` };
}

function classify(e: unknown): ErrKind {
  const { code, text } = errInfo(e);
  if ((code === 429 || /RESOURCE_EXHAUSTED/.test(text)) && /PerDay|per day|daily|limit:\s*0/i.test(text)) return "quota";
  if (code === 429 || /RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(text)) return "busy"; // batas per menit: tunggu lalu coba lagi
  if ([500, 502, 503, 504].includes(code) || /UNAVAILABLE|INTERNAL|DEADLINE|overloaded|high demand|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(text)) return "busy";
  if ([401, 403].includes(code) || /API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) return "auth";
  if (code === 404 || /NOT_FOUND|not found for API/i.test(text)) return "model";
  return "other";
}

/** Ubah galat mentah penyedia menjadi pesan Indonesia yang bisa ditindaklanjuti. */
function friendly(e: unknown, model: string, tried: number, waitedMs: number): LlmError {
  if (e instanceof LlmError) return e;
  const kind = classify(e);
  const { code, status, raw } = errInfo(e);
  const tech = `${code || ""} ${status}`.trim() || raw.slice(0, 120);
  const msgs: Record<ErrKind, string> = {
    busy: `Layanan AI (${model}) sedang padat dan belum menjawab setelah dicoba ${tried} kali selama ${Math.round(waitedMs / 1000)} detik. Biasanya sementara: klik “Coba lagi” beberapa menit lagi. Bila sering terjadi, isi LLM_FALLBACK_MODEL di .env.local dengan model lain. (${tech})`,
    quota: `Kuota pemakaian AI untuk model ${model} habis atau tidak tersedia untuk akun Anda. Cek kuota di https://aistudio.google.com/rate-limit, ganti LLM_MODEL (npm run llm:check menampilkan model yang tersedia), atau tunggu kuota harian pulih. (${tech})`,
    auth: `API key ditolak penyedia AI. Periksa GEMINI_API_KEY di .env.local (tanpa spasi/kutip), pastikan key aktif, lalu jalankan ulang server. (${tech})`,
    model: `Model "${model}" tidak ditemukan untuk key Anda. Jalankan npm run llm:check untuk melihat model yang tersedia, lalu isi LLM_MODEL di .env.local. (${tech})`,
    other: `Panggilan AI gagal: ${raw.slice(0, 300)}`,
  };
  return new LlmError(msgs[kind], kind);
}

/**
 * Coba ulang HANYA untuk galat sementara (server padat, batas per menit, jaringan), dengan jeda bertahap
 * (±2, 4, 8, 15, 20 detik, diacak sedikit) selama paling lama LLM_RETRY_BUDGET_MS (bawaan 45 detik, di bawah batas
 * fungsi serverless 60 detik). Galat kuota, key, atau model langsung dilempar tanpa menunggu.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  model: string,
  budgetMs = Number(process.env.LLM_RETRY_BUDGET_MS ?? 45000),
  onNotice?: (message: string) => void,
): Promise<T> {
  const t0 = Date.now();
  const delays = [2000, 4000, 8000, 15000, 20000];
  for (let i = 0; ; i++) {
    try {
      await throttle();
      return await fn();
    } catch (e) {
      const waited = Date.now() - t0;
      const delay = (delays[i] ?? 20000) * (0.8 + Math.random() * 0.4);
      if (classify(e) !== "busy" || waited + delay > budgetMs) throw friendly(e, model, i + 1, waited);
      console.warn(`[llm] ${model}: ${errInfo(e).code || "galat sementara"} — coba ulang ${i + 2} dalam ${Math.round(delay / 1000)} dtk`);
      onNotice?.(
        `AI ${model} sedang padat atau lambat (${errInfo(e).code || "tanpa jawaban"}) — percobaan ulang ke-${i + 2} dalam ${Math.round(delay / 1000)} detik. Ini bukan galat; tunggu saja.`,
      );
      await sleep(delay);
    }
  }
}

let geminiClient: import("@google/genai").GoogleGenAI | undefined;
async function gemini() {
  if (!geminiClient) {
    const { GoogleGenAI } = await import("@google/genai");
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY belum diisi di .env.local");
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

let groqClient: InstanceType<typeof import("groq-sdk").default> | undefined;
async function groq() {
  if (!groqClient) {
    const Groq = (await import("groq-sdk")).default;
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY belum diisi di .env.local");
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

async function providerCall(system: string, user: string, model: string, temperature: number, opts: CallOptions) {
  const p = llmProvider();
  if (p === "gemini") {
    const ai = await gemini();
    // Batas waktu per panggilan (LLM_CALL_TIMEOUT_MS, bawaan 120 dtk): saat Gemini padat, jawaban bisa tertahan bermenit-menit.
    // Panggilan yang melewati batas dibatalkan dan diperlakukan sebagai "padat" → dicoba ulang / pindah ke model cadangan.
    const timeoutMs = Number(process.env.LLM_CALL_TIMEOUT_MS ?? 120000);
    const once = async (m: string) => {
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new Error(`DEADLINE_EXCEEDED: ${m} tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          ai.models.generateContent({
            model: m,
            contents: user,
            config: { systemInstruction: system, temperature, responseMimeType: "application/json", abortSignal: ctl.signal },
          }),
          expired,
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const generate = (m: string, budget?: number) => withRetry(() => once(m), m, budget, opts.onNotice);
    let res: Awaited<ReturnType<typeof generate>>;
    let used = model;
    const fb = fallbackModel(model);
    // Pemutus sirkuit: selama model utama baru saja terdeteksi padat, langsung pakai cadangan (hemat ±30 dtk per panggilan).
    if (fb && (primaryBusyUntil.get(model) ?? 0) > Date.now()) {
      try {
        return toResult(await generate(fb, 30000), fb);
      } catch {
        // cadangan juga gagal → kembali mencoba model utama di bawah
      }
    }
    try {
      res = await generate(model);
      primaryBusyUntil.delete(model);
    } catch (e) {
      // Model utama padat/tidak tersedia: pakai model cadangan (LLM_FALLBACK_MODEL=none untuk mematikan).
      // Model yang benar-benar dipakai tercatat di llm_calls.model, jadi bisa disaring saat analisis eksperimen.
      if (!fb || !(e instanceof LlmError) || (e.kind !== "busy" && e.kind !== "model")) throw e;
      primaryBusyUntil.set(model, Date.now() + Number(process.env.LLM_FALLBACK_COOLDOWN_MS ?? 300000));
      opts.onNotice?.(`Model ${model} padat; memakai model cadangan ${fb}.`);
      console.warn(`[llm] ${model} gagal (${e.kind}); memakai model cadangan ${fb} selama ${Math.round(Number(process.env.LLM_FALLBACK_COOLDOWN_MS ?? 300000) / 60000)} menit`);
      try {
        res = await generate(fb, 30000);
        used = fb;
      } catch {
        throw e; // laporkan galat model utama
      }
    }
    return toResult(res, used);
  }
  if (p === "groq") {
    return groqCall(system, user, model, temperature);
  }
  return mockCall(system, user, opts);
}

/** Model utama yang sedang padat → kapan boleh dicoba lagi. */
const primaryBusyUntil = new Map<string, number>();

type GenResult = {
  text?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};
function toResult(res: GenResult, model: string) {
  return {
    text: res.text ?? "",
    tokensIn: res.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
    model,
  };
}

async function groqCall(system: string, user: string, model: string, temperature: number) {
  const client = await groq();
  const res = await withRetry(
    () =>
      client.chat.completions.create({
        model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    model,
  );
  return {
    text: res.choices[0]?.message?.content ?? "",
    tokensIn: res.usage?.prompt_tokens ?? 0,
    tokensOut: res.usage?.completion_tokens ?? 0,
    model,
  };
}

/** Mode uji: tanpa API key, deterministik; token diperkirakan ~4 karakter per token. */
async function mockCall(system: string, user: string, opts: CallOptions) {
  const text = JSON.stringify(opts.mock ? opts.mock() : {});
  await sleep(Number(process.env.MOCK_LATENCY_MS ?? 30));
  return { text, tokensIn: Math.ceil((system.length + user.length) / 4), tokensOut: Math.ceil(text.length / 4), model: "mock" };
}

export async function callLlm(system: string, user: string, opts: CallOptions = {}): Promise<LlmResult> {
  const model = opts.model || defaultModel();
  const temperature = opts.temperature ?? Number(process.env.LLM_TEMPERATURE ?? 0.2);
  const t0 = Date.now();
  // Panggil SDK Gemini atau Groq sesuai LLM_PROVIDER; minta output JSON dan ambil jumlah token dari metadata.
  const r = (await providerCall(system, user, model, temperature, opts)) as { text: string; tokensIn: number; tokensOut: number; model?: string };
  return { text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs: Date.now() - t0, model: r.model ?? model };
}

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 768);

/** Embedding selalu lewat Gemini (Groq tidak menyediakan API embedding); mock memakai hashing kata. */
export async function embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
  if (llmProvider() === "mock" || process.env.EMBEDDING_PROVIDER === "mock") {
    return texts.map((t) => mockEmbedding(t, EMBEDDING_DIM));
  }
  const model = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
  // 1) Cache: teks yang sudah pernah diembed (kueri yang sama di setiap run) diambil dari basis data.
  const { createHash } = await import("node:crypto");
  const keys = texts.map((t) => createHash("sha256").update(`${model}|${EMBEDDING_DIM}|${kind}|${t}`).digest("hex"));
  const cached = await readEmbeddingCache(keys);
  const missing = texts.map((t, i) => ({ t, i })).filter((x) => !cached.has(keys[x.i]));
  if (missing.length) {
    const ai = await gemini();
    // Batas per menit embedding biasanya pulih setelah ±60 dtk → anggaran coba ulang lebih panjang daripada teks.
    const budget = Number(process.env.EMBED_RETRY_BUDGET_MS ?? 90000);
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      const res = await withRetry(
        () =>
          ai.models.embedContent({
            model,
            contents: batch.map((b) => b.t),
            config: {
              outputDimensionality: EMBEDDING_DIM,
              taskType: kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
            },
          }),
        model,
        budget,
      );
      const vecs = (res.embeddings ?? []).map((e) => e.values ?? []);
      if (vecs.length !== batch.length || vecs.some((v) => v.length !== EMBEDDING_DIM))
        throw new Error(`Dimensi embedding tidak sama dengan EMBEDDING_DIM=${EMBEDDING_DIM}`);
      batch.forEach((b, j) => cached.set(keys[b.i], vecs[j]));
      await writeEmbeddingCache(batch.map((b, j) => [keys[b.i], vecs[j]] as [string, number[]]));
    }
  }
  return keys.map((k) => cached.get(k)!);
}

async function readEmbeddingCache(keys: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!keys.length) return out;
  try {
    const { queryRows } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const rows = await queryRows<{ key: string; v: string }>(
      sql`SELECT key, embedding::text AS v FROM embedding_cache WHERE key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`,
    );
    for (const r of rows) out.set(r.key, JSON.parse(r.v));
  } catch {
    /* tabel cache belum ada (migrasi belum dijalankan) → tanpa cache */
  }
  return out;
}

async function writeEmbeddingCache(rows: [string, number[]][]) {
  try {
    const { queryRows } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    for (const [k, v] of rows)
      await queryRows(sql`INSERT INTO embedding_cache (key, embedding) VALUES (${k}, ${JSON.stringify(v)}::vector) ON CONFLICT (key) DO NOTHING`);
  } catch {
    /* cache bersifat tambahan; gagal menyimpan tidak menggagalkan analisis */
  }
}

/** Hanya untuk pengujian. */
export const _internals = { classify, friendly, withRetry };
