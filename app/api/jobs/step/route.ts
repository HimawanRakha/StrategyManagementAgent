import { NextResponse } from "next/server";
import { z } from "zod";
import { processJob } from "@/lib/engine/queue";

// Satu analisis bisa butuh beberapa panggilan AI (masing-masing ≤ LLM_CALL_TIMEOUT_MS). 300 dtk = batas Vercel (Fluid Compute) paket Hobby.
export const maxDuration = 300;

const Body = z.object({ runId: z.string().uuid(), nodeKey: z.string() });

/**
 * Dipanggil QStash untuk menjalankan satu job. Tanda tangan QStash diverifikasi;
 * route ini idempoten (job yang sudah done/berjalan dilewati).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  if (current) {
    const { Receiver } = await import("@upstash/qstash");
    const receiver = new Receiver({ currentSigningKey: current, nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY ?? current });
    const ok = await receiver
      .verify({ signature: req.headers.get("upstash-signature") ?? "", body: raw })
      .catch(() => false);
    if (!ok) return NextResponse.json({ error: "Tanda tangan QStash tidak valid" }, { status: 401 });
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "QStash belum dikonfigurasi" }, { status: 403 });
  }
  const body = Body.parse(JSON.parse(raw));
  const result = await processJob(body.runId, body.nodeKey);
  // 500 membuat QStash mencoba ulang (maks 3 kali); setelah itu status job = failed.
  return NextResponse.json({ result }, { status: result === "retry" ? 500 : 200 });
}
