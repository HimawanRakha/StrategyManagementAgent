"use client";
import { useMemo, useState } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Select, Table } from "@/components/ui";
import { api, fmt, useApi } from "@/lib/client/api";
import { nodeLabel } from "@/lib/nodes/meta";
import { wilson } from "@/lib/experiment/wilson";
import { ApiErrorNote, Note, WilsonCell, stageOrder } from "./shared";

type InjectorInfo = { type: string; label: string; check: string; description?: string };
type Recent = { id: string; nodeKey: string; errorType: string; itemId: string; detected: boolean | null; repaired: boolean | null; createdAt: string };
type InjResponse = { injectors: Record<string, InjectorInfo[]>; eligible: Record<string, number>; all?: InjectorInfo[]; recent: Recent[] };
type InjResult =
  | { id?: string; nodeKey: string; errorType: string; itemId: string; location?: string; description: string; detected: boolean | null; repaired: boolean | null }
  | { error: string; nodeRunId: string };

const yesNo = (v: boolean | null | undefined) =>
  v === null || v === undefined ? <Badge>–</Badge> : v ? <Badge tone="ok">ya</Badge> : <Badge tone="danger">tidak</Badge>;

/** Tab "Penyuntikan galat": ukur d (deteksi) dan r (perbaikan) validator. */
export function InjectionTab() {
  const { data, error, loading, reload } = useApi<InjResponse>("/api/injections");
  const nodes = useMemo(() => Object.keys(data?.injectors ?? {}).filter((k) => data!.injectors[k].length).sort(stageOrder), [data]);
  const [nodeKey, setNodeKey] = useState("");
  const [errorType, setErrorType] = useState("");
  const [count, setCount] = useState("1");
  const [requireClean, setRequireClean] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [results, setResults] = useState<InjResult[] | null>(null);

  const node = nodeKey || nodes[0] || "";
  const types = data?.injectors[node] ?? [];
  const type = types.some((t) => t.type === errorType) ? errorType : (types[0]?.type ?? "");
  const injector = types.find((t) => t.type === type);
  const typeLabel = (t: string) => (data?.all ?? types).find((x) => x.type === t)?.label ?? t;
  const eligible = data?.eligible[node] ?? 0;

  const summary = useMemo(() => {
    const by = new Map<string, { n: number; det: number; rep: number }>();
    for (const r of data?.recent ?? []) {
      if (r.detected === null) continue;
      const s = by.get(r.nodeKey) ?? { n: 0, det: 0, rep: 0 };
      s.n++;
      if (r.detected) {
        s.det++;
        if (r.repaired) s.rep++;
      }
      by.set(r.nodeKey, s);
    }
    return [...by.entries()].sort((a, b) => stageOrder(a[0], b[0]));
  }, [data]);

  async function run() {
    const n = Math.min(5, Math.max(1, Math.round(Number(count) || 1)));
    setBusy(true);
    setRunErr(null);
    setResults(null);
    try {
      const res = await api<{ results: InjResult[] }>("/api/injections", { body: { nodeKey: node, errorType: type, count: n, requireClean } });
      setResults(res.results);
      reload();
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <ApiErrorNote message={error} />;
  if (loading && !data) return <Loading />;

  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr]">
        <Card
          title="Suntikkan galat"
          subtitle="Sisipkan satu galat yang diketahui ke output analisis, jalankan validator + perbaikan, lalu catat apakah galat terdeteksi dan diperbaiki."
        >
          {nodes.length === 0 ? (
            <Empty>
              Belum ada analisis yang bisa disuntik. Penyuntikan butuh analisis yang disusun AI dan punya validator (pemeriksaan otomatis); analisis yang
              dihitung program dilewati.
            </Empty>
          ) : (
            <div className="space-y-3">
              <Field label="Node">
                <Select value={node} onChange={(e) => setNodeKey(e.target.value)}>
                  {nodes.map((k) => (
                    <option key={k} value={k}>
                      {nodeLabel(k)} — {data?.eligible[k] ?? 0} output bersih
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Jenis galat"
                hint={
                  injector ? (
                    <>
                      {injector.description} Seharusnya tertangkap oleh: {injector.check}.
                    </>
                  ) : types.length === 0 ? (
                    "Output terakhir analisis ini tidak punya bagian yang bisa disuntik."
                  ) : undefined
                }
              >
                <Select value={type} onChange={(e) => setErrorType(e.target.value)}>
                  {types.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Jumlah penyuntikan (1–5)" hint="Tiap penyuntikan memilih output acak dan memanggil validator (memakan token).">
                <Input type="number" min={1} max={5} value={count} onChange={(e) => setCount(e.target.value)} className="w-24" />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={requireClean} onChange={(e) => setRequireClean(e.target.checked)} />
                <span>
                  Hanya output berputusan bersih
                  <span className="block text-[11px] text-muted">
                    Disarankan: galat yang sudah ada di output akan mengacaukan ukuran d dan r. Tersedia {eligible} output bersih untuk node ini.
                  </span>
                </span>
              </label>
              {requireClean && eligible === 0 && (
                <p className="text-xs text-warn">Belum ada output bersih untuk node ini — beri putusan dulu atau matikan syarat ini.</p>
              )}
              <Button variant="primary" loading={busy} disabled={!node || !type} onClick={run}>
                {busy ? "Menjalankan validator…" : "Suntikkan dan uji"}
              </Button>
              <ErrorBox error={runErr} />
            </div>
          )}
        </Card>

        <Card title="Ringkasan d dan r per node" subtitle={`Dari ${data?.recent.length ?? 0} penyuntikan terbaru (maks. 100); estimasi lengkap ada di tab Parameter.`}>
          {summary.length === 0 ? (
            <Empty>Belum ada penyuntikan yang selesai dinilai.</Empty>
          ) : (
            <Table head={["Node", "n", "d (terdeteksi)", "r (diperbaiki | terdeteksi)", "d×r"]}>
              {summary.map(([k, s]) => {
                const d = wilson(s.det, s.n);
                const r = wilson(s.rep, s.det);
                return (
                  <tr key={k} className="tabular-nums">
                    <td className="font-medium whitespace-nowrap">{nodeLabel(k)}</td>
                    <td>{s.n}</td>
                    <td>
                      <WilsonCell w={d} />
                    </td>
                    <td>
                      <WilsonCell w={r} />
                    </td>
                    <td>{fmt.num((Number.isFinite(d.p) ? d.p : 0) * (Number.isFinite(r.p) ? r.p : 0), 3)}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      </div>

      {results && (
        <Card title="Hasil penyuntikan ini">
          <Table head={["Analisis", "Jenis", "Butir", "Lokasi & deskripsi", "Terdeteksi", "Diperbaiki"]}>
            {results.map((r, i) =>
              "error" in r ? (
                <tr key={i}>
                  <td colSpan={6} className="text-danger">
                    Gagal: {r.error}
                  </td>
                </tr>
              ) : (
                <tr key={i}>
                  <td className="whitespace-nowrap">{nodeLabel(r.nodeKey)}</td>
                  <td className="text-xs">{typeLabel(r.errorType)}</td>
                  <td className="font-mono text-xs">{r.itemId}</td>
                  <td className="text-xs">
                    {r.location && <div className="font-mono text-[11px] text-muted">{r.location}</div>}
                    {r.description}
                  </td>
                  <td>{yesNo(r.detected)}</td>
                  <td>{r.detected ? yesNo(r.repaired) : <Badge>–</Badge>}</td>
                </tr>
              ),
            )}
          </Table>
        </Card>
      )}

      <Card title="Riwayat penyuntikan">
        {!data?.recent.length ? (
          <Empty>Belum ada penyuntikan.</Empty>
        ) : (
          <Table head={["Waktu", "Analisis", "Jenis", "Butir", "Terdeteksi", "Diperbaiki"]}>
            {data.recent.map((r) => (
              <tr key={r.id}>
                <td className="text-xs whitespace-nowrap text-muted">{fmt.date(r.createdAt)}</td>
                <td className="whitespace-nowrap">{nodeLabel(r.nodeKey)}</td>
                <td className="text-xs">{typeLabel(r.errorType)}</td>
                <td className="font-mono text-xs">{r.itemId}</td>
                <td>{yesNo(r.detected)}</td>
                <td>{r.detected ? yesNo(r.repaired) : <Badge>–</Badge>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Note>
        Penyuntik bersifat generik: bekerja pada output analisis apa pun dengan mencari pola umum (kutipan bukti, rujukan ID, angka penilaian,
        perbandingan AHP, daftar butir). d = proporsi galat suntikan yang ditangkap validator; r = proporsi galat terdeteksi yang berhasil
        diperbaiki siklus perbaikan. Panggilan LLM penyuntikan tidak dihitung ke biaya cᵛ.
      </Note>
    </div>
  );
}
