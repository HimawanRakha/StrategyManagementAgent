"use client";
// Helper fetch untuk komponen client. Browser hanya memanggil API route; API key tetap di server.
import { useCallback, useEffect, useRef, useState } from "react";

/** Galat API dengan status HTTP (mis. 401 = sesi login berakhir). */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
    headers: opts.form ? undefined : opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

/** Ambil data JSON dan sediakan reload(); `intervalMs` untuk polling (mis. status antrean). */
export function useApi<T>(url: string | null, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `loading` diturunkan dari URL terakhir yang selesai dimuat (tanpa setState sinkron di effect).
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loading = !!url && loadedUrl !== url;
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (!url) return;
    try {
      const d = await api<T>(url);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoadedUrl(url);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    const first = setTimeout(reload, 0); // pemuatan awal di luar badan effect
    const t = intervalMs ? setInterval(reload, intervalMs) : undefined;
    return () => {
      alive.current = false;
      clearTimeout(first);
      if (t) clearInterval(t);
    };
  }, [reload, intervalMs, url]);

  return { data, error, loading, reload, setData };
}

/** Unduh respons file (DOCX/PDF/CSV) dari API route. */
export async function download(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "unduhan";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const fmt = {
  num: (n: number | null | undefined, d = 3) =>
    n === null || n === undefined || !Number.isFinite(n) ? "–" : n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d }),
  int: (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("id-ID")),
  pct: (n: number | null | undefined, d = 0) =>
    n === null || n === undefined || !Number.isFinite(n) ? "–" : `${(n * 100).toLocaleString("id-ID", { maximumFractionDigits: d })}%`,
  date: (s: string | Date | null | undefined) => (s ? new Date(s).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "–"),
};
