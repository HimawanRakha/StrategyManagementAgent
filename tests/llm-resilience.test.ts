import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const busy503 = new Error(
  JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } }),
);

describe("ketahanan panggilan LLM", () => {
  afterEach(() => vi.useRealTimers());

  it("mengelompokkan galat penyedia", async () => {
    const { _internals: x } = await import("@/lib/llm/provider");
    expect(x.classify(busy503)).toBe("busy");
    expect(x.classify(new Error(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded: GenerateRequestsPerDayPerProject limit: 20" } })))).toBe("quota");
    expect(x.classify(new Error(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many requests per minute" } })))).toBe("busy");
    expect(x.classify(new Error(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } })))).toBe("auth");
    expect(x.classify(new Error(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "models/foo is not found for API version" } })))).toBe("model");
    expect(x.classify(new Error("fetch failed"))).toBe("busy");
  });

  it("mencoba ulang galat sementara sampai berhasil", async () => {
    vi.useFakeTimers();
    const { _internals: x } = await import("@/lib/llm/provider");
    let calls = 0;
    const p = x.withRetry(async () => {
      if (++calls < 3) throw busy503;
      return "ok";
    }, "m", 60000);
    await vi.advanceTimersByTimeAsync(30000);
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("menyerah dengan pesan Indonesia setelah anggaran waktu habis", async () => {
    vi.useFakeTimers();
    const { _internals: x, LlmError } = await import("@/lib/llm/provider");
    const p = x.withRetry(async () => {
      throw busy503;
    }, "gemini-x", 10000);
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(60000);
    const e = await caught;
    expect(e).toBeInstanceOf(LlmError);
    expect(e.kind).toBe("busy");
    expect(e.message).toMatch(/sedang padat/);
    expect(e.message).toMatch(/Coba lagi/);
  });

  it("tidak menunggu untuk galat kuota/key/model", async () => {
    const { _internals: x } = await import("@/lib/llm/provider");
    let calls = 0;
    await expect(
      x.withRetry(async () => {
        calls++;
        throw new Error(JSON.stringify({ error: { code: 400, message: "API key not valid" } }));
      }, "m"),
    ).rejects.toThrow(/API key ditolak/);
    expect(calls).toBe(1);
  });
});
