// npm run llm:check — memastikan API key dan model LLM berfungsi (tanpa mencetak key).
// Menguji: (1) pembuatan teks JSON, (2) embedding sesuai EMBEDDING_DIM. Bila gagal, menampilkan model yang tersedia.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);

async function listModels() {
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const pager = await ai.models.list();
    const gen: string[] = [];
    const emb: string[] = [];
    for await (const m of pager) {
      const name = (m.name ?? "").replace(/^models\//, "");
      const acts = (m as { supportedActions?: string[] }).supportedActions ?? [];
      if (/embed/i.test(name) || acts.includes("embedContent")) emb.push(name);
      else if (acts.includes("generateContent") && /flash/i.test(name)) gen.push(name);
    }
    console.log("\nModel teks (flash) yang tersedia untuk key Anda — salin salah satu ke LLM_MODEL di .env.local:");
    for (const n of gen.slice(0, 20)) console.log("   " + n);
    console.log("Model embedding yang tersedia (EMBEDDING_MODEL):");
    for (const n of emb.slice(0, 8)) console.log("   " + n);
  } catch (e) {
    console.log("  (daftar model tidak bisa diambil:", (e as Error).message.slice(0, 160) + ")");
  }
}

async function main() {
  const { llmProvider, defaultModel, callLlm, embed } = await import("../lib/llm/provider");
  const provider = llmProvider();
  const model = defaultModel();
  console.log("Pemeriksaan LLM");
  console.log(`  penyedia  : ${provider}${(process.env.LLM_PROVIDER ?? "auto") === "auto" ? " (otomatis dari key yang terisi)" : ""}`);
  console.log(`  model     : ${model}`);
  console.log(`  GEMINI_API_KEY: ${process.env.GEMINI_API_KEY?.trim() ? "terisi" : "KOSONG"}   GROQ_API_KEY: ${process.env.GROQ_API_KEY?.trim() ? "terisi" : "KOSONG"}`);

  if (provider === "mock") {
    console.log("\nMasih MODE UJI (tanpa AI). Isi GEMINI_API_KEY di .env.local lalu jalankan perintah ini lagi.");
    console.log("Buat key di https://aistudio.google.com/apikey");
    process.exit(0);
  }

  let failed = false;
  console.log("\n1. Pembuatan teks (JSON)");
  try {
    const r = await callLlm('Balas HANYA JSON {"ok":true,"kota":"Surabaya"}', 'Sebutkan kota tempat ITS berada dalam format JSON yang diminta.');
    const j = JSON.parse(r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
    if (j && typeof j === "object") ok(`berhasil (${r.latencyMs} ms, ${r.tokensIn}+${r.tokensOut} token) → ${JSON.stringify(j)}`);
    else throw new Error("bukan objek JSON");
  } catch (e) {
    failed = true;
    bad((e as Error).message.slice(0, 300));
  }

  console.log("\n2. Embedding (dipakai untuk mencari bukti di dokumen)");
  try {
    const v = await embed(["uji embedding dokumen"], "document");
    const dim = Number(process.env.EMBEDDING_DIM ?? 768);
    if (v[0]?.length === dim) ok(`berhasil, dimensi ${dim} sesuai EMBEDDING_DIM`);
    else throw new Error(`dimensi ${v[0]?.length} ≠ EMBEDDING_DIM ${dim}`);
  } catch (e) {
    failed = true;
    bad((e as Error).message.slice(0, 300));
  }

  if (failed && provider === "gemini") await listModels();
  console.log(failed ? "\nAda yang gagal — lihat pesan di atas." : "\nSemua siap. Jalankan ulang server (npm run dev) lalu coba canvas.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
