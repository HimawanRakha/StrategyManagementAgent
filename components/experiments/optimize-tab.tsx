"use client";
import { useMemo, useState } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Select, Table, Toggle, cx } from "@/components/ui";
import { api, fmt, useApi } from "@/lib/client/api";
import { NODE_KEYS, NODE_META, nodeLabel, type NodeKey } from "@/lib/nodes/meta";
import { ASSUMED, MIN_N_USE } from "@/lib/experiment/assumptions";
import { optimize, optimizeDP } from "@/lib/experiment/optimize";
import { placementCost, predictP, type Stage } from "@/lib/experiment/propagation";
import { QualityCurve } from "./quality-curve";
import { ApiErrorNote, Note, PlacementLegend, PlacementList, isAuthExpired, parseList, parseNum, fin, type ParamsResponse, type Placement } from "./shared";

type Edit = { e: string; dr: string; cTok: string; cMin: string };
type Method = "auto" | "brute" | "dp";
export type OptResult = { budgetTokens: number; budgetMinutes: number; placement: Placement; predictedP: number; dpP: number | null; baselineP: number };
type Out = { stages: Stage[]; dh: number; method: string; results: OptResult[]; local: boolean };
type SavedRow = { id?: string; experimentTag: string; method: string; budgetTokens: number; budgetMinutes: number; placement: Placement; predictedP: number; createdAt: string };

/** Contoh angka dari brief penelitian (dipasang ke tiga analisis SGS; bisa dipakai untuk analisis mana pun). */
const EXAMPLE_KEYS: NodeKey[] = ["swot_matrix", "qspm", "cascading"];
const EXAMPLE_VALUES: Edit[] = [
  { e: "0.20", dr: "0.6", cTok: "3000", cMin: "8" },
  { e: "0.06", dr: "0.5", cTok: "1500", cMin: "3" },
  { e: "0.13", dr: "0.8", cTok: "2500", cMin: "6" },
];
const DP_UNIT = 500;

/** Asumsi umum untuk analisis apa pun yang belum punya angka terukur (sama dengan laporan di canvas). */
function assumedEdit(k: string): Edit {
  const isCode = NODE_META[k as NodeKey]?.kind === "code";
  return { e: String(isCode ? ASSUMED.eCode : ASSUMED.e), dr: String(ASSUMED.dr), cTok: String(ASSUMED.cTok), cMin: String(ASSUMED.cMin) };
}

/** Tab "Optimasi": pilih penempatan validator/tinjauan terbaik untuk sederet anggaran. */
export function OptimizeTab({ params, paramsError }: { params: ParamsResponse | null; paramsError: string | null }) {
  const stageKeys = useMemo(() => params?.stages.map((s) => s.key) ?? [...NODE_KEYS], [params]);
  const defaultSelected = useMemo(() => params?.stages.filter((s) => s.e.n > 0 && Number.isFinite(fin(s.e.p))).map((s) => s.key) ?? [], [params]);

  const [tag, setTag] = useState("opt");
  const [selected, setSelected] = useState<string[] | null>(null); // null = ikut default dari parameter
  const [edits, setEdits] = useState<Record<string, Partial<Edit>>>({});
  const [dhStr, setDhStr] = useState<string | null>(null);
  const [minutesStr, setMinutesStr] = useState("0, 5, 10, 15, 20, 30");
  const [tokensStr, setTokensStr] = useState("0, 3000, 6000, 10000");
  const [method, setMethod] = useState<Method>("auto");
  const [local, setLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<Out | null>(null);
  const savedUrl = tag.trim() ? `/api/experiments/optimize?tag=${encodeURIComponent(tag.trim())}` : null;
  const saved = useApi<{ results: SavedRow[] }>(savedUrl);
  const [clearing, setClearing] = useState(false);

  const sel = (selected ?? defaultSelected).slice().sort((a, b) => stageKeys.indexOf(a) - stageKeys.indexOf(b));
  const dhDefault = params?.dh ?? 0.85;
  const dh = dhStr ?? String(dhDefault);

  /** Nilai awal: terukur (bila datanya cukup) atau asumsi umum. */
  const defaults = (k: string): Edit => {
    const s = params?.stages.find((x) => x.key === k);
    const a = assumedEdit(k);
    const e = fin(s?.e.p);
    return {
      e: s && s.e.n >= MIN_N_USE && Number.isFinite(e) ? e.toFixed(3) : a.e,
      // d×r: nyata (run sungguhan) → uji sisip → asumsi (sama dengan laporan di canvas)
      dr: s?.drObserved ? s.drObserved.dr.toFixed(3) : s && s.d.n >= MIN_N_USE ? s.dr.toFixed(3) : a.dr,
      cTok: s && s.cTokN > 0 ? String(s.cTok) : a.cTok,
      cMin: s && s.cMinN > 0 ? String(s.cMin) : a.cMin,
    };
  };
  const measured = (k: string) => {
    const s = params?.stages.find((x) => x.key === k);
    return { e: !!s && s.e.n >= MIN_N_USE, dr: !!s && (!!s.drObserved || s.d.n >= MIN_N_USE), cTok: !!s && s.cTokN > 0, cMin: !!s && s.cMinN > 0 };
  };
  const value = (k: string): Edit => ({ ...defaults(k), ...edits[k] });

  const minutes = parseList(minutesStr);
  const tokens = parseList(tokensStr);
  const combos = minutes.length * tokens.length;

  function toggleStage(k: string, on: boolean) {
    const cur = new Set(sel);
    if (on) cur.add(k);
    else cur.delete(k);
    setSelected([...cur]);
  }

  function loadBrief() {
    setSelected(EXAMPLE_KEYS);
    setEdits(Object.fromEntries(EXAMPLE_KEYS.map((k, i) => [k, EXAMPLE_VALUES[i]])));
    setDhStr("0.85");
    setMinutesStr("8");
    setTokensStr("3000");
    setMethod("auto");
    setLocal(true);
    setErr(null);
    setOut(null);
  }

  function buildStages(): Stage[] {
    return sel.map((k) => {
      const v = value(k);
      const st = { key: k, e: parseNum(v.e), dr: parseNum(v.dr), cTok: parseNum(v.cTok), cMin: parseNum(v.cMin) };
      if (![st.e, st.dr].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) throw new Error(`${nodeLabel(k)}: e dan d×r harus di antara 0 dan 1`);
      if (![st.cTok, st.cMin].every((x) => Number.isFinite(x) && x >= 0)) throw new Error(`${nodeLabel(k)}: biaya harus angka ≥ 0`);
      return st;
    });
  }

  async function run() {
    setErr(null);
    let stages: Stage[];
    try {
      if (!sel.length) throw new Error("Pilih minimal satu tahap.");
      if (!minutes.length || !tokens.length) throw new Error("Isi daftar anggaran menit dan token.");
      stages = buildStages();
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    const dhN = parseNum(dh);
    if (!(dhN >= 0 && dhN <= 1)) return setErr("dʰ harus di antara 0 dan 1.");
    const budgets = tokens.flatMap((t) => minutes.map((m) => ({ tokens: t, minutes: m })));
    const m = method === "auto" ? (stages.length <= 8 ? "brute" : "dp") : method;
    if (m === "brute" && stages.length > 11) return setErr("Brute force terlalu besar untuk > 11 tahap; pakai DP.");

    if (local) {
      const baselineP = predictP(stages, {}, dhN);
      const results = budgets.map((b) => {
        const best = m === "brute" ? optimize(stages, dhN, b.tokens, b.minutes) : optimizeDP(stages, dhN, b.tokens, b.minutes, DP_UNIT);
        const check = stages.length <= 8 ? optimizeDP(stages, dhN, b.tokens, b.minutes, DP_UNIT) : null;
        return { budgetTokens: b.tokens, budgetMinutes: b.minutes, placement: best.place, predictedP: best.p, dpP: check?.p ?? null, baselineP };
      });
      setOut({ stages, dh: dhN, method: m, results, local: true });
      return;
    }

    if (budgets.length > 60) return setErr(`Server menerima maks. 60 kombinasi anggaran (sekarang ${budgets.length}).`);
    if (!tag.trim()) return setErr("Isi experiment tag.");
    setBusy(true);
    try {
      const overrides = Object.fromEntries(stages.map((s) => [s.key, { e: s.e, dr: s.dr, cTok: s.cTok, cMin: s.cMin }]));
      const res = await api<{ stages: Stage[]; dh: number; method: string; results: OptResult[] }>("/api/experiments/optimize", {
        body: { experimentTag: tag.trim(), keys: sel, overrides, dh: dhN, budgets, method },
      });
      const keys = res.stages.map((s) => s.key);
      setOut({ stages: res.stages, dh: res.dh, method: res.method, results: res.results, local: false });
      if (keys.length < sel.length) setErr(`Server mengabaikan tahap: ${sel.filter((k) => !keys.includes(k)).map(nodeLabel).join(", ")}.`);
      saved.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearSaved() {
    if (!window.confirm(`Hapus semua hasil optimasi tersimpan dengan tag "${tag}"? Tindakan ini tidak bisa dibatalkan.`)) return;
    setClearing(true);
    try {
      await api(`/api/experiments/optimize?tag=${encodeURIComponent(tag.trim())}`, { method: "DELETE" });
      saved.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setClearing(false);
    }
  }

  if (isAuthExpired(paramsError) || isAuthExpired(saved.error)) return <ApiErrorNote message={paramsError ?? saved.error} />;

  return (
    <div className="space-y-4">
      <Note>
        Model: eᵢ′ = eᵢ(1 − xᵢdᵢrᵢ)(1 − yᵢdʰ), P = Π(1 − eᵢ′). Optimasi memilih xᵢ (1 = validator dipasang di tahap i) dan yᵢ (1 = tinjauan
        manusia dipasang) yang memaksimalkan P dengan Σ xᵢcᵢᵛ ≤ anggaran token dan Σ yᵢcᵢʰ ≤ anggaran menit, untuk setiap kombinasi anggaran.
        Tahap tanpa angka terukur memakai asumsi umum (e = {String(ASSUMED.e).replace(".", ",")}, d×r = {String(ASSUMED.dr).replace(".", ",")}, cᵛ ={" "}
        {fmt.int(ASSUMED.cTok)} token, cʰ = {ASSUMED.cMin} menit) yang bisa diubah.
      </Note>
      <Card
        title="Masukan optimasi"
        subtitle="Parameter tahap terisi dari hasil estimasi dan bisa diubah (analisis sensitivitas). Nilai yang diubah dikirim sebagai overrides."
        actions={
          <Button size="sm" onClick={loadBrief} title="Angka contoh brief untuk matriks SWOT, QSPM, dan cascading">
            Muat contoh angka
          </Button>
        }
      >
        {!params && !paramsError && <Loading label="Memuat parameter…" />}
        <ErrorBox error={paramsError} />
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">Tahap yang dioptimasi</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {stageKeys.map((k) => {
                const hasE = defaultSelected.includes(k);
                return (
                  <label key={k} className="inline-flex items-center gap-1.5 text-sm" title={hasE ? "punya data e" : "belum ada data e (isi manual)"}>
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={sel.includes(k)} onChange={(e) => toggleStage(k, e.target.checked)} />
                    <span className={hasE ? undefined : "text-muted"}>{nodeLabel(k)}</span>
                  </label>
                );
              })}
            </div>
            {params && defaultSelected.length === 0 && (
              <p className="mt-1.5 text-xs text-warn">
                Belum ada tahap dengan data e. Pilih tahap (angka awalnya asumsi umum dan bisa diubah), atau klik &ldquo;Muat contoh angka&rdquo;.
              </p>
            )}
          </div>

          {sel.length > 0 && (
            <Table
              head={[
                "Tahap",
                <span key="e" title="Peluang analisis keliru bila tidak diperiksa">e (peluang keliru)</span>,
                <span key="dr" title="Peluang validator menemukan dan memperbaiki kekeliruan">d×r (daya validator)</span>,
                <span key="t" title="Token tambahan bila validator dipasang">cᵛ token validator</span>,
                <span key="m" title="Menit pengurus bila tinjauan manusia dipasang">cʰ menit tinjauan</span>,
                "",
              ]}
            >
              {sel.map((k) => {
                const v = value(k);
                const set = (f: keyof Edit, s: string) => setEdits((cur) => ({ ...cur, [k]: { ...cur[k], [f]: s } }));
                const dirty = (Object.keys(v) as (keyof Edit)[]).some((f) => edits[k]?.[f] !== undefined && edits[k]?.[f] !== defaults(k)[f]);
                return (
                  <tr key={k}>
                    <td className="font-medium whitespace-nowrap">{nodeLabel(k)}</td>
                    {(["e", "dr", "cTok", "cMin"] as const).map((f) => (
                      <td key={f}>
                        <Input value={v[f]} onChange={(e) => set(f, e.target.value)} inputMode="decimal" className="h-8 w-24 tabular-nums" aria-label={`${f} ${nodeLabel(k)}`} />
                        <div className="mt-0.5 text-[10px] text-muted">
                          {edits[k]?.[f] !== undefined ? "diubah" : measured(k)[f] ? "terukur" : "asumsi"}
                        </div>
                      </td>
                    ))}
                    <td>
                      {dirty && (
                        <button
                          type="button"
                          className="text-xs text-muted hover:text-text hover:underline"
                          onClick={() => setEdits((cur) => Object.fromEntries(Object.entries(cur).filter(([x]) => x !== k)))}
                        >
                          reset
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="dʰ (deteksi tinjauan manusia)" hint={`Bawaan dari pengaturan: ${fmt.num(dhDefault, 2)}`}>
              <Input value={dh} onChange={(e) => setDhStr(e.target.value)} inputMode="decimal" className="tabular-nums" />
            </Field>
            <Field label="Anggaran menit (daftar)" hint={`${minutes.length} nilai`}>
              <Input value={minutesStr} onChange={(e) => setMinutesStr(e.target.value)} className="tabular-nums" />
            </Field>
            <Field label="Anggaran token (daftar)" hint={`${tokens.length} nilai → ${combos} kombinasi`}>
              <Input value={tokensStr} onChange={(e) => setTokensStr(e.target.value)} className="tabular-nums" />
            </Field>
            <Field label="Metode" hint={`auto: brute force bila ≤ 8 tahap, selain itu DP (token dibulatkan ke ${DP_UNIT})`}>
              <Select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                <option value="auto">auto</option>
                <option value="brute">brute force</option>
                <option value="dp">pemrograman dinamis (DP)</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t border-border pt-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Mode</span>
              <Toggle checked={local} onChange={setLocal} label={local ? "hitung lokal (tanpa simpan)" : "simpan ke server"} />
            </div>
            <Field label="Experiment tag hasil" className={cx(local && "opacity-50")}>
              <Input value={tag} onChange={(e) => setTag(e.target.value)} disabled={local} className="w-40" />
            </Field>
            <Button variant="primary" loading={busy} onClick={run}>
              Jalankan optimasi
            </Button>
          </div>
          <ErrorBox error={err} />
        </div>
      </Card>

      {out && <ResultsCard out={out} />}

      <Card
        title={`Hasil tersimpan${tag.trim() ? ` · tag "${tag.trim()}"` : ""}`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={saved.reload} disabled={!savedUrl}>
              Muat ulang
            </Button>
            <Button size="sm" variant="danger" loading={clearing} disabled={!savedUrl || !saved.data?.results.length} onClick={clearSaved}>
              Hapus tag ini
            </Button>
          </>
        }
      >
        {!savedUrl ? (
          <Empty>Isi experiment tag untuk melihat hasil tersimpan.</Empty>
        ) : saved.loading && !saved.data ? (
          <Loading />
        ) : saved.error ? (
          <ErrorBox error={saved.error} />
        ) : !saved.data?.results.length ? (
          <Empty>Belum ada hasil tersimpan untuk tag ini.</Empty>
        ) : (
          <Table head={["Waktu", "Metode", "Token", "Menit", "Penempatan", "P prediksi"]}>
            {saved.data.results.map((r, i) => (
              <tr key={r.id ?? i} className="tabular-nums">
                <td className="text-xs whitespace-nowrap text-muted">{fmt.date(r.createdAt)}</td>
                <td className="text-xs">{r.method}</td>
                <td>{fmt.int(r.budgetTokens)}</td>
                <td>{fmt.num(r.budgetMinutes, 0)}</td>
                <td>
                  <PlacementList placement={r.placement} />
                </td>
                <td className="font-medium">{fmt.num(r.predictedP, 3)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function ResultsCard({ out }: { out: Out }) {
  const keys = out.stages.map((s) => s.key);
  const best = Math.max(...out.results.map((r) => r.predictedP));
  return (
    <>
      <Card
        title="Hasil optimasi"
        subtitle={`${out.results.length} anggaran · metode ${out.method} · dʰ = ${fmt.num(out.dh, 2)}`}
        actions={<Badge tone={out.local ? "neutral" : "ok"}>{out.local ? "dihitung lokal, tidak disimpan" : "tersimpan di server"}</Badge>}
      >
        <Table head={["Token", "Menit", "Penempatan terbaik", "Biaya terpakai", "P prediksi", "Cek DP", "P tanpa cek"]}>
          {out.results.map((r, i) => {
            const cost = placementCost(out.stages, r.placement);
            const dpOk = r.dpP === null ? null : Math.abs(r.dpP - r.predictedP) < 1e-9;
            return (
              <tr key={i} className={cx("tabular-nums", r.predictedP === best && "bg-primary-soft")}>
                <td>{fmt.int(r.budgetTokens)}</td>
                <td>{fmt.num(r.budgetMinutes, 0)}</td>
                <td className="min-w-56">
                  <PlacementList placement={r.placement} keys={keys} />
                </td>
                <td className="text-xs whitespace-nowrap text-muted">
                  {fmt.int(cost.tok)} tok · {fmt.num(cost.min, 1)} mnt
                </td>
                <td className="font-semibold">{fmt.num(r.predictedP, 3)}</td>
                <td className="whitespace-nowrap">
                  {r.dpP === null ? (
                    <span className="text-muted">–</span>
                  ) : (
                    <span title={dpOk ? "DP sama dengan brute force" : `DP berbeda: biaya token dibulatkan ke atas per ${DP_UNIT}, jadi DP lebih konservatif`}>
                      {fmt.num(r.dpP, 3)} {dpOk ? <Badge tone="ok">sama</Badge> : <Badge tone="warn">beda</Badge>}
                    </span>
                  )}
                </td>
                <td className="text-muted">{fmt.num(r.baselineP, 3)}</td>
              </tr>
            );
          })}
        </Table>
        <PlacementLegend className="mt-2" />
        <p className="mt-1 text-[11px] text-muted">
          Analisis yang tidak disebut di kolom penempatan = tanpa pemeriksaan. Baris berlatar hijau memberi P tertinggi. &ldquo;Cek DP&rdquo;
          membandingkan brute force dengan pemrograman dinamis (hanya untuk ≤ 8 tahap).
        </p>
      </Card>
      <QualityCurve results={out.results} />
    </>
  );
}
