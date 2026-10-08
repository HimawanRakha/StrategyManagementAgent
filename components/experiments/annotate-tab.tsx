"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Empty, Field, Input, Loading, Select, cx } from "@/components/ui";
import { api } from "@/lib/client/api";
import { nodeLabel } from "@/lib/nodes/meta";
import { ERROR_TYPES } from "@/lib/codebook";
import { Highlighted, findQuote } from "@/components/annotate/highlight";
import { ApiErrorNote, Note } from "./shared";

type Item = { id: string; text: string; detail?: string };
type Chunk = { id: string; content: string; source: string; kind: string };
type NextItem = {
  nodeRunId: string;
  nodeKey: string;
  label: string;
  description: string;
  items: Item[];
  output: unknown;
  evidence: Chunk[];
  context: { nodeKey: string; label: string; items: Item[] }[];
};
type NextResponse = { item: NextItem | null; progress: { done: number; total: number }; codebook: { version: string; text: string }; nodeKeys: string[] };
type Draft = { isError: boolean | null; errorType: string; note: string };
type Ev = { chunkId: string; quote: string };

const ERROR_LABEL: Record<string, string> = {
  unsupported: "Tidak didukung bukti",
  wrong_quadrant: "Kuadran tertukar",
  invalid_ref: "Rujukan tidak valid",
  wrong_rating: "Penilaian/rating salah",
  contradiction: "Kontradiksi",
  not_measurable: "Tidak terukur",
  hallucination: "Halusinasi",
  other: "Lainnya",
};

const NAME_KEY = "strategi-agen.annotator";

function readName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeName(v: string) {
  try {
    if (v) window.localStorage.setItem(NAME_KEY, v);
    else window.localStorage.removeItem(NAME_KEY);
  } catch {
    /* penyimpanan browser tidak tersedia: nama hanya berlaku di sesi ini */
  }
}

/** Kumpulkan bukti per item dari output (butir ber-`id` yang punya `evidence[]` di kedalaman mana pun — bentuk output tiap analisis berbeda). */
function evidenceByItem(output: unknown): Map<string, Ev[]> {
  const map = new Map<string, Ev[]>();
  const isEv = (e: unknown): e is Ev => !!e && typeof e === "object" && typeof (e as Ev).chunkId === "string" && typeof (e as Ev).quote === "string";
  const visit = (x: unknown, depth: number) => {
    if (!x || typeof x !== "object" || depth > 8) return;
    if (Array.isArray(x)) {
      for (const v of x) visit(v, depth + 1);
      return;
    }
    const o = x as { id?: unknown; evidence?: unknown };
    if (typeof o.id === "string" && Array.isArray(o.evidence)) {
      const evs = o.evidence.filter(isEv);
      if (evs.length) map.set(o.id, [...(map.get(o.id) ?? []), ...evs]);
    }
    for (const v of Object.values(x as Record<string, unknown>)) if (v && typeof v === "object") visit(v, depth + 1);
  };
  visit(output, 0);
  return map;
}

/** Tab "Anotasi": penilaian buta per item output. Satu akun bersama, penilai dibedakan lewat nama. */
export function AnnotateTab() {
  const [annotator, setAnnotator] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = readName();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nama penilai dari localStorage hanya tersedia di browser
    setAnnotator(saved);
    setNameDraft(saved);
    setReady(true);
  }, []);

  if (!ready) return <Loading />;
  if (!annotator)
    return (
      <NameForm
        value={nameDraft}
        onChange={setNameDraft}
        onSubmit={() => {
          const v = nameDraft.trim();
          if (!v) return;
          writeName(v);
          setAnnotator(v);
        }}
      />
    );
  return (
    <Annotator
      key={annotator}
      annotator={annotator}
      onChangeName={() => {
        writeName("");
        setAnnotator("");
      }}
    />
  );
}

const KAPPA_NOTE =
  "Dua penilai berbeda (mis. Azizah dan Himawan) menilai output yang sama tanpa melihat konfigurasi run; kesepakatan dihitung dengan Cohen's kappa.";

function NameForm({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  return (
    <Card title="Siapa yang menilai?" subtitle="Isi nama Anda sebelum mulai. Nama disimpan di browser ini." className="mx-auto max-w-xl">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Note>{KAPPA_NOTE} Pakai nama yang sama setiap kali menilai agar progres Anda tersambung.</Note>
        <Field label="Nama penilai">
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="mis. Azizah" autoFocus required maxLength={60} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            Mulai menilai
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Annotator({ annotator, onChangeName }: { annotator: string; onChangeName: () => void }) {
  const [nodeKey, setNodeKey] = useState("");
  const [data, setData] = useState<NextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [codebookOpen, setCodebookOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const load = useCallback(
    async (key: string) => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ annotator });
        if (key) q.set("nodeKey", key);
        const d = await api<NextResponse>(`/api/annotate/next?${q.toString()}`);
        setData(d);
        setDrafts({});
        setFocus(null);
        setSaveErr(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [annotator],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- memuat item pertama saat filter berubah
    load(nodeKey);
  }, [load, nodeKey]);

  const item = data?.item ?? null;
  const evMap = useMemo(() => evidenceByItem(item?.output), [item]);
  const hasItemEvidence = evMap.size > 0;

  const draft = (id: string): Draft => drafts[id] ?? { isError: null, errorType: "", note: "" };
  const setDraft = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...draft(id), ...patch } }));
  const labeled = item ? item.items.filter((it) => draft(it.id).isError !== null).length : 0;
  const complete = !!item && labeled === item.items.length;

  function markAllClean() {
    if (!item) return;
    setDrafts((d) => {
      const next = { ...d };
      for (const it of item.items) if ((next[it.id]?.isError ?? null) === null) next[it.id] = { isError: false, errorType: "", note: next[it.id]?.note ?? "" };
      return next;
    });
  }

  async function submit() {
    if (!item || !complete) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await api("/api/annotations", {
        body: {
          nodeRunId: item.nodeRunId,
          annotator,
          labels: item.items.map((it) => {
            const d = draft(it.id);
            return { itemId: it.id, isError: !!d.isError, errorType: d.isError ? d.errorType || "other" : null, note: d.note.trim() || null };
          }),
        },
      });
      setLastSaved(item.label);
      await load(nodeKey);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const progress = data?.progress;
  const pct = progress && progress.total ? (progress.done / progress.total) * 100 : 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 max-w-2xl text-sm">
          <p>
            Menilai sebagai <b>{annotator}</b>{" "}
            <button type="button" onClick={onChangeName} className="text-xs font-medium text-primary hover:underline">
              ganti nama
            </button>
          </p>
          <p className="mt-1 text-xs text-muted">
            Nilai setiap item output: galat atau tidak. Identitas run, konfigurasi, dan tag eksperimen disembunyikan. {KAPPA_NOTE}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Analisis" className="min-w-52">
            <Select value={nodeKey} onChange={(e) => setNodeKey(e.target.value)} disabled={loading && !data}>
              <option value="">Semua analisis</option>
              {(data?.nodeKeys ?? []).map((k) => (
                <option key={k} value={k}>
                  {nodeLabel(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="ghost" onClick={() => setCodebookOpen((o) => !o)}>
            {codebookOpen ? "Tutup codebook" : "Codebook"}
          </Button>
        </div>
      </div>

      {progress && (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>
              Progres{nodeKey ? ` · ${nodeLabel(nodeKey)}` : ""}: <b className="tabular-nums text-text">{progress.done}</b> dari{" "}
              <span className="tabular-nums">{progress.total}</span> output dinilai
            </span>
            <span className="tabular-nums">{Math.round(pct)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {lastSaved && !loading && (
        <p className="mb-3 text-xs text-ok">
          Label untuk {lastSaved} tersimpan. {item ? "Item berikutnya dimuat." : ""}
        </p>
      )}

      <div className={cx("grid gap-4", codebookOpen && "xl:grid-cols-[minmax(0,1fr)_380px]")}>
        <div className="min-w-0">
          {error ? (
            <ApiErrorNote message={error} />
          ) : loading && !data ? (
            <Loading label="Mengambil item…" />
          ) : !item ? (
            progress && progress.total === 0 ? (
              <Empty>
                <p className="font-medium text-text">Belum ada output untuk dinilai</p>
                <p className="mt-1">Output muncul di sini setelah ada run yang selesai (mis. dari tab Run batch).</p>
              </Empty>
            ) : (
              <Empty>
                <p className="font-medium text-text">Semua item sudah dinilai</p>
                <p className="mt-1">
                  {nodeKey ? `Tidak ada lagi output ${nodeLabel(nodeKey)} untuk Anda.` : "Terima kasih — tidak ada output tersisa untuk Anda."} Item baru muncul
                  setelah run baru selesai.
                </p>
              </Empty>
            )
          ) : (
            <div className={cx("grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]", loading && "pointer-events-none opacity-60")}>
              <Card
                title={
                  <span className="flex items-center gap-2">
                    {item.label}
                    <Badge tone="neutral">{item.items.length} item</Badge>
                  </span>
                }
                subtitle={item.description}
                actions={
                  <Button size="sm" variant="ghost" onClick={markAllClean} disabled={complete}>
                    Tandai semua tidak galat
                  </Button>
                }
              >
                {item.items.length === 0 ? (
                  <Empty>Output ini tidak memiliki item untuk dinilai.</Empty>
                ) : (
                  <ul className="divide-y divide-border">
                    {item.items.map((it) => {
                      const d = draft(it.id);
                      const evs = evMap.get(it.id);
                      return (
                        <li key={it.id} className={cx("py-3 first:pt-0 last:pb-0", focus === it.id && "-mx-2 rounded-md bg-info-soft/60 px-2")}>
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold">{it.id}</span>
                            <button
                              type="button"
                              className={cx("min-w-0 flex-1 text-left", hasItemEvidence && "cursor-pointer hover:text-primary")}
                              onClick={() => setFocus(focus === it.id ? null : it.id)}
                              title={evs ? "Tampilkan bukti kutipan" : undefined}
                            >
                              <div className="text-sm">{it.text}</div>
                              {it.detail && <div className="mt-0.5 text-xs whitespace-pre-wrap text-muted">{it.detail}</div>}
                              {evs && <div className="mt-0.5 text-[11px] text-info">{evs.length} kutipan · klik untuk melihat bukti</div>}
                            </button>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 pl-0 sm:pl-9">
                            <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label={`Label ${it.id}`}>
                              <button
                                type="button"
                                onClick={() => setDraft(it.id, { isError: true })}
                                className={cx("h-8 px-3 text-xs font-medium", d.isError === true ? "bg-danger text-white" : "bg-surface hover:bg-danger-soft")}
                                aria-pressed={d.isError === true}
                              >
                                Galat
                              </button>
                              <button
                                type="button"
                                onClick={() => setDraft(it.id, { isError: false, errorType: "" })}
                                className={cx("h-8 border-l border-border px-3 text-xs font-medium", d.isError === false ? "bg-ok text-white" : "bg-surface hover:bg-ok-soft")}
                                aria-pressed={d.isError === false}
                              >
                                Tidak galat
                              </button>
                            </div>
                            <Select
                              value={d.errorType}
                              onChange={(e) => setDraft(it.id, { errorType: e.target.value })}
                              disabled={d.isError !== true}
                              className="h-8 text-xs"
                              aria-label="Jenis galat"
                            >
                              <option value="">Jenis galat…</option>
                              {ERROR_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {ERROR_LABEL[t] ?? t} ({t})
                                </option>
                              ))}
                            </Select>
                            <Input
                              value={d.note}
                              onChange={(e) => setDraft(it.id, { note: e.target.value })}
                              placeholder="Catatan (opsional)"
                              className="h-8 min-w-40 flex-1 text-xs"
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                  <Button variant="primary" onClick={submit} loading={saving} disabled={!complete || item.items.length === 0}>
                    Simpan dan lanjut
                  </Button>
                  <span className="text-xs text-muted tabular-nums">
                    {labeled}/{item.items.length} item berlabel
                    {!complete && " — semua item wajib dilabeli"}
                  </span>
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => load(nodeKey)} disabled={saving}>
                    Lewati
                  </Button>
                </div>
                {saveErr && (
                  <div className="mt-2">
                    <ApiErrorNote message={saveErr} />
                  </div>
                )}
                <details className="mt-4 text-xs">
                  <summary className="cursor-pointer text-muted hover:text-text">Output lengkap (JSON)</summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] whitespace-pre-wrap">
                    {JSON.stringify(item.output, null, 2)}
                  </pre>
                </details>
              </Card>

              <div className="space-y-4">
                <EvidencePanel item={item} evMap={evMap} focus={focus} onClear={() => setFocus(null)} />
                <ContextPanel context={item.context} />
              </div>
            </div>
          )}
        </div>

        {codebookOpen && data?.codebook && (
          <aside className="xl:sticky xl:top-18 xl:self-start">
            <Card
              title="Codebook"
              subtitle={`Versi ${data.codebook.version}`}
              actions={
                <Button size="sm" variant="ghost" onClick={() => setCodebookOpen(false)}>
                  Tutup
                </Button>
              }
            >
              <pre className="max-h-[70vh] overflow-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{data.codebook.text}</pre>
            </Card>
          </aside>
        )}
      </div>
    </div>
  );
}

function EvidencePanel({ item, evMap, focus, onClear }: { item: NextItem; evMap: Map<string, Ev[]>; focus: string | null; onClear: () => void }) {
  const chunks = useMemo(() => new Map(item.evidence.map((c) => [c.id, c])), [item.evidence]);
  const evs = focus ? evMap.get(focus) : undefined;

  if (focus && evs) {
    const byChunk = new Map<string, string[]>();
    for (const e of evs) byChunk.set(e.chunkId, [...(byChunk.get(e.chunkId) ?? []), e.quote]);
    return (
      <Card
        title={`Bukti untuk ${focus}`}
        subtitle="Kutipan disorot di potongan sumber (tanpa peduli huruf besar-kecil dan spasi)."
        actions={
          <Button size="sm" variant="ghost" onClick={onClear}>
            Tutup
          </Button>
        }
      >
        <div className="space-y-3">
          {[...byChunk.entries()].map(([cid, quotes]) => {
            const c = chunks.get(cid);
            if (!c)
              return (
                <div key={cid} className="rounded-md border border-danger/30 bg-danger-soft p-2.5 text-xs text-danger">
                  Potongan <b>{cid}</b> tidak ada di bukti yang diberikan ke agen. Kutipan: &ldquo;{quotes.join("”, “")}&rdquo;
                </div>
              );
            const missing = quotes.filter((q) => !findQuote(c.content, q));
            return (
              <div key={cid} className="rounded-md border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-2.5 py-1.5 text-[11px]">
                  <span className="font-mono font-semibold">{c.id}</span>
                  <span className="truncate text-muted" title={c.source}>
                    {c.source}
                  </span>
                </div>
                <div className="max-h-72 overflow-auto px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap">
                  <Highlighted content={c.content} quotes={quotes} />
                </div>
                {missing.length > 0 && (
                  <div className="border-t border-border bg-warn-soft px-2.5 py-1.5 text-[11px] text-warn">
                    Kutipan tidak ditemukan di potongan ini: &ldquo;{missing.join("”, “")}&rdquo;
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    );
  }

  return (
    <Card title="Bukti sumber" subtitle={evMap.size ? "Klik item untuk menyorot kutipannya." : `${item.evidence.length} potongan yang diberikan ke agen.`}>
      {item.evidence.length === 0 ? (
        <p className="text-xs text-muted">Node ini tidak menerima potongan dokumen.</p>
      ) : (
        <div className="max-h-[60vh] space-y-1.5 overflow-auto">
          {item.evidence.map((c) => (
            <details key={c.id} className="rounded-md border border-border text-xs">
              <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
                <span className="font-mono font-semibold">{c.id}</span>
                <span className="truncate text-muted">{c.source}</span>
                {c.kind === "user_answer" && <Badge tone="info">jawaban pengguna</Badge>}
              </summary>
              <div className="border-t border-border px-2.5 py-2 leading-relaxed whitespace-pre-wrap">{c.content}</div>
            </details>
          ))}
        </div>
      )}
    </Card>
  );
}

function ContextPanel({ context }: { context: NextItem["context"] }) {
  if (!context.length) return null;
  return (
    <Card title="Konteks node induk" subtitle="Item induk yang dirujuk output ini (mis. SO1 → S2, O1).">
      <div className="max-h-[50vh] space-y-3 overflow-auto">
        {context.map((c) => (
          <details key={c.nodeKey} open={context.length <= 2}>
            <summary className="cursor-pointer text-xs font-semibold">
              {c.label} <span className="font-normal text-muted">({c.items.length})</span>
            </summary>
            <ul className="mt-1.5 space-y-1">
              {c.items.map((it) => (
                <li key={it.id} className="flex gap-2 text-xs">
                  <span className="shrink-0 font-mono font-semibold">{it.id}</span>
                  <span className="min-w-0">
                    {it.text}
                    {it.detail && <span className="block text-[11px] text-muted">{it.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </Card>
  );
}
