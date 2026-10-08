"use client";
import { useState } from "react";
import { Badge, Button, Card, ErrorBox, Field, Input, Select, Stat, Table, Toggle } from "@/components/ui";
import { api, fmt } from "@/lib/client/api";
import { NODE_KEYS, NODE_META, nodeLabel } from "@/lib/nodes/meta";
import { Note, PlacementChip, PlacementLegend, fin, parseNum, stageOrder, type ParamsResponse, type Placement } from "./shared";

type SimResponse = {
  stages: { key: string; e: number; dr: number; h: number; cTok: number; cMin: number }[];
  simulated: number;
  product: number;
  markov: number;
  trials: number;
};
type Ov = { e: string; dr: string; h: string };

/** Tab "Simulasi": Monte Carlo pada graf bercabang vs rumus perkalian vs rantai Markov. */
export function SimulateTab({ params, canvas }: { params: ParamsResponse | null; canvas?: { workflowId: string; projectName: string; keys: string[] } | null }) {
  const [graphSel, setGraph] = useState<"mvp" | "full" | "canvas">("mvp");
  // Pilihan "canvas" hanya berlaku selama proyek terpilih punya canvas dengan analisis.
  const graph = graphSel === "canvas" && !canvas?.keys.length ? "mvp" : graphSel;
  const [placement, setPlacement] = useState<Placement>({});
  const [ov, setOv] = useState<Record<string, Partial<Ov>>>({});
  const [dh, setDh] = useState("");
  const [trials, setTrials] = useState("100000");
  const [useH, setUseH] = useState(false);
  const [seed, setSeed] = useState("42");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<SimResponse | null>(null);

  const keys: string[] = graph === "canvas" ? [...(canvas?.keys ?? [])].sort(stageOrder) : NODE_KEYS.filter((k) => graph === "full" || NODE_META[k].phase === 1);
  const toggle = (k: string, f: "validator" | "human") =>
    setPlacement((p) => {
      const c = p[k] ?? { validator: false, human: false };
      return { ...p, [k]: { ...c, [f]: !c[f] } };
    });

  async function run() {
    setErr(null);
    const overrides: Record<string, { e?: number; dr?: number; h?: number }> = {};
    for (const k of keys) {
      const o = ov[k];
      if (!o) continue;
      const x: { e?: number; dr?: number; h?: number } = {};
      for (const f of ["e", "dr", "h"] as const) {
        const s = o[f]?.trim();
        if (!s) continue;
        const n = parseNum(s);
        if (!(n >= 0 && n <= 1)) return setErr(`${nodeLabel(k)}: ${f} harus di antara 0 dan 1`);
        x[f] = n;
      }
      if (Object.keys(x).length) overrides[k] = x;
    }
    const t = Math.round(Number(trials));
    if (!(t >= 1000 && t <= 500_000)) return setErr("Jumlah percobaan harus 1.000–500.000.");
    const dhN = dh.trim() ? parseNum(dh) : undefined;
    if (dhN !== undefined && !(dhN >= 0 && dhN <= 1)) return setErr("dʰ harus di antara 0 dan 1.");
    const seedN = seed.trim() ? Math.round(Number(seed)) : undefined;
    const pl = Object.fromEntries(keys.filter((k) => placement[k]).map((k) => [k, placement[k]]));
    setBusy(true);
    try {
      setRes(
        await api<SimResponse>("/api/experiments/simulate", {
          body: { graph: graph === "canvas" ? "full" : graph, workflowId: graph === "canvas" ? canvas?.workflowId : undefined, placement: pl, overrides: Object.keys(overrides).length ? overrides : undefined, dh: dhN, trials: t, useH, seed: Number.isFinite(seedN) ? seedN : undefined },
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const se = res ? Math.sqrt((res.product * (1 - res.product)) / res.trials) : 0;
  const diff = res ? Math.abs(res.simulated - res.product) : 0;
  const allZeroH = res ? res.stages.every((s) => s.h === 0) : false;

  return (
    <div className="space-y-4">
      <Note>
        Sanity check model: dengan <b>h = 0</b> (tanpa pemulihan) dan rantai yang semua node-nya harus bersih, simulasi Monte Carlo, rumus
        perkalian P = Π(1 − eᵢ′), dan model Markov seharusnya sama (selisih simulasi hanya galat acak ≈ 2·SE). Dengan h &gt; 0, Markov dan simulasi
        memperhitungkan node yang memulihkan galat dari input, sehingga P bisa lebih tinggi dari rumus perkalian.
      </Note>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="Penempatan dan parameter" subtitle="Kosongkan kolom e/d×r/h untuk memakai nilai terukur (ditampilkan samar).">
          <Table head={["Analisis", "Validator", "Tinjauan manusia", "Pilihan", "e", "d×r", "h"]}>
            {keys.map((k) => {
              const c = placement[k];
              const p = params?.stages.find((s) => s.key === k);
              const ph = {
                e: Number.isFinite(fin(p?.e.p)) ? fin(p?.e.p).toFixed(3) : "0",
                dr: p ? p.dr.toFixed(3) : "0",
                h: Number.isFinite(fin(p?.h.p)) ? fin(p?.h.p).toFixed(3) : "0",
              };
              return (
                <tr key={k}>
                  <td className="font-medium whitespace-nowrap">{nodeLabel(k)}</td>
                  <td>
                    <input type="checkbox" className="size-4 accent-[var(--info)]" checked={!!c?.validator} onChange={() => toggle(k, "validator")} aria-label={`Validator ${nodeLabel(k)}`} />
                  </td>
                  <td>
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={!!c?.human} onChange={() => toggle(k, "human")} aria-label={`Tinjauan manusia ${nodeLabel(k)}`} />
                  </td>
                  <td>
                    <PlacementChip c={c} />
                  </td>
                  {(["e", "dr", "h"] as const).map((f) => (
                    <td key={f}>
                      <Input
                        value={ov[k]?.[f] ?? ""}
                        placeholder={ph[f]}
                        onChange={(e) => setOv((cur) => ({ ...cur, [k]: { ...cur[k], [f]: e.target.value } }))}
                        inputMode="decimal"
                        className="h-8 w-20 tabular-nums"
                        disabled={f === "h" && !useH}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </Table>
          <PlacementLegend className="mt-2" />
        </Card>

        <div className="space-y-4">
          <Card title="Pengaturan simulasi">
            <div className="space-y-3">
              <Field label="Graf">
                <Select value={graph} onChange={(e) => setGraph(e.target.value as "mvp" | "full" | "canvas")}>
                  <option value="mvp">Ringkas (ES + SGS, sampai cascading)</option>
                  <option value="full">Lengkap (sampai grand design)</option>
                  {canvas && canvas.keys.length > 0 && <option value="canvas">Pakai canvas proyek terpilih ({canvas.projectName})</option>}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Percobaan (trials)">
                  <Input value={trials} onChange={(e) => setTrials(e.target.value)} inputMode="numeric" className="tabular-nums" />
                </Field>
                <Field label="Seed (opsional)">
                  <Input value={seed} onChange={(e) => setSeed(e.target.value)} inputMode="numeric" className="tabular-nums" />
                </Field>
              </div>
              <Field label="dʰ" hint={`Kosong = dari pengaturan (${fmt.num(params?.dh, 2)})`}>
                <Input value={dh} onChange={(e) => setDh(e.target.value)} placeholder={params ? String(params.dh) : ""} inputMode="decimal" className="tabular-nums" />
              </Field>
              <Toggle checked={useH} onChange={setUseH} label="Pakai pemulihan h" />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" loading={busy} onClick={run}>
                  Jalankan simulasi
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPlacement({});
                    setOv({});
                  }}
                >
                  Reset
                </Button>
              </div>
              <ErrorBox error={err} />
            </div>
          </Card>

          {res && (
            <Card title="Hasil" subtitle={`${fmt.int(res.trials)} run virtual`}>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-1">
                <Stat label="Monte Carlo (simulasi)" value={fmt.num(res.simulated, 4)} hint={`SE ≈ ${fmt.num(se, 4)}`} />
                <Stat label="Rumus perkalian Π(1 − eᵢ′)" value={fmt.num(res.product, 4)} hint="mengabaikan h" />
                <Stat label="Model Markov (rantai + h)" value={fmt.num(res.markov, 4)} hint="rantai lurus dengan pemulihan" />
              </div>
              <div className="mt-3 text-xs">
                {allZeroH ? (
                  diff <= 2 * se + 1e-9 ? (
                    <Badge tone="ok">Cocok: |simulasi − rumus| = {fmt.num(diff, 4)} ≤ 2·SE</Badge>
                  ) : (
                    <Badge tone="warn">Menyimpang: |simulasi − rumus| = {fmt.num(diff, 4)} &gt; 2·SE — cek struktur graf/sink</Badge>
                  )
                ) : (
                  <span className="text-muted">h &gt; 0 pada sebagian node: perbedaan dengan rumus perkalian memang diharapkan.</span>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {res && (
        <Card title="Parameter tahap yang dipakai">
          <Table head={["Node", "e", "d×r", "h", "cᵛ token", "cʰ menit", "Penempatan"]}>
            {res.stages.map((s) => (
              <tr key={s.key} className="tabular-nums">
                <td className="font-medium whitespace-nowrap">{nodeLabel(s.key)}</td>
                <td>{fmt.num(s.e, 3)}</td>
                <td>{fmt.num(s.dr, 3)}</td>
                <td>{fmt.num(s.h, 3)}</td>
                <td>{fmt.int(s.cTok)}</td>
                <td>{fmt.num(s.cMin, 1)}</td>
                <td>
                  <PlacementChip c={placement[s.key]} />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
