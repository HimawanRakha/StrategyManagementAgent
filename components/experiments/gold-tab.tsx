"use client";
import { useMemo, useState } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Loading, Table, Textarea, cx } from "@/components/ui";
import { api, fmt, useApi } from "@/lib/client/api";
import { agentFactors, compareGold } from "@/lib/experiment/gold";
import { ApiErrorNote, Note } from "./shared";

/** Output analisis faktor dari run utama proyek (untuk dibandingkan dengan kunci jawaban). */
export type GoldOutputs = { faktor_internal?: unknown; faktor_eksternal?: unknown };

type Quadrant = "S" | "W" | "O" | "T";
type GoldFactor = { id: string; quadrant: Quadrant; text: string };

const QUADRANTS: { q: Quadrant; label: string; hint: string; tone: string }[] = [
  { q: "S", label: "Kekuatan", hint: "Internal · positif", tone: "border-t-ok" },
  { q: "W", label: "Kelemahan", hint: "Internal · negatif", tone: "border-t-danger" },
  { q: "O", label: "Peluang", hint: "Eksternal · positif", tone: "border-t-info" },
  { q: "T", label: "Ancaman", hint: "Eksternal · negatif", tone: "border-t-warn" },
];

type Row = { key: string; quadrant: Quadrant; text: string };
let seq = 0;
const newKey = () => `n${++seq}`;

/** Tab "Kunci jawaban": faktor S/W/O/T acuan proyek terpilih (bermakna untuk kasus sintetis), dibandingkan dengan faktor hasil agen. */
export function GoldTab({ projectId, isSynthetic, outputs }: { projectId: string | null; isSynthetic: boolean; outputs?: GoldOutputs }) {
  const { data, error, loading } = useApi<{ gold: GoldFactor[] }>(projectId ? `/api/projects/${projectId}/gold` : null);
  if (!projectId) return <Empty>Pilih proyek di atas terlebih dahulu.</Empty>;
  return (
    <div className="space-y-3">
      {!isSynthetic && (
        <Note>
          Proyek ini bukan kasus sintetis (contoh). Kunci jawaban paling berguna untuk kasus sintetis, karena faktor &ldquo;benar&rdquo;-nya diketahui
          sehingga ketepatan agen bisa diukur. Untuk organisasi nyata, bagian ini boleh dikosongkan.
        </Note>
      )}
      {error && !data ? (
        <ApiErrorNote message={error} />
      ) : loading || !data ? (
        <Loading label="Memuat kunci jawaban…" />
      ) : (
        <GoldEditor key={projectId} projectId={projectId} gold={data.gold} outputs={outputs ?? {}} />
      )}
    </div>
  );
}

function GoldEditor({ projectId, gold, outputs }: { projectId: string; gold: GoldFactor[]; outputs: GoldOutputs }) {
  const [rows, setRows] = useState<Row[]>(() => gold.map((g) => ({ key: g.id, quadrant: g.quadrant, text: g.text })));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = (next: Row[]) => {
    setRows(next);
    setDirty(true);
    setSaved(false);
  };
  const invalid = rows.filter((r) => r.text.trim().length > 0 && r.text.trim().length < 2).length;

  async function save() {
    const factors = rows.map((r) => ({ quadrant: r.quadrant, text: r.text.trim() })).filter((f) => f.text.length >= 2);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/gold`, { body: { factors } });
      setRows((rs) => rs.filter((r) => r.text.trim().length >= 2));
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
    <Card
      title="Kunci jawaban faktor S/W/O/T"
      subtitle="Faktor acuan untuk kasus sintetis; dibandingkan dengan hasil analisis Faktor internal (S+W) dan Faktor eksternal (O+T)."
      actions={
        <>
          {dirty && <Badge tone="warn">belum disimpan</Badge>}
          {saved && !dirty && <Badge tone="ok">tersimpan</Badge>}
          <Button variant="primary" size="sm" loading={busy} disabled={!dirty || invalid > 0} onClick={save}>
            Simpan kunci jawaban
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Note>Menyimpan akan mengganti seluruh kunci jawaban proyek ini. Baris kosong diabaikan.</Note>
        <ErrorBox error={error} />
        <div className="grid gap-3 md:grid-cols-2">
          {QUADRANTS.map(({ q, label, hint, tone }) => {
            const list = rows.filter((r) => r.quadrant === q);
            return (
              <div key={q} className={cx("rounded-md border border-border border-t-2 bg-surface", tone)}>
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <div>
                    <span className="font-mono text-xs font-semibold">{q}</span> <span className="text-sm font-semibold">{label}</span>
                    <span className="ml-2 text-[11px] text-muted">{hint}</span>
                  </div>
                  <span className="text-xs text-muted tabular-nums">{list.length}</span>
                </div>
                <ul className="space-y-1.5 px-3 pb-3">
                  {list.map((r, i) => (
                    <li key={r.key} className="flex items-start gap-1.5">
                      <span className="mt-2 w-6 shrink-0 font-mono text-[11px] text-muted">
                        {q}
                        {i + 1}
                      </span>
                      <Textarea
                        value={r.text}
                        rows={1}
                        onChange={(e) => update(rows.map((x) => (x.key === r.key ? { ...x, text: e.target.value } : x)))}
                        className={cx("min-h-9 flex-1 resize-y", r.text.trim().length === 1 && "border-danger")}
                        placeholder={`Faktor ${label.toLowerCase()}…`}
                      />
                      <button
                        type="button"
                        onClick={() => update(rows.filter((x) => x.key !== r.key))}
                        className="mt-1 rounded px-1.5 py-1 text-muted hover:bg-danger-soft hover:text-danger"
                        title="Hapus baris"
                        aria-label="Hapus baris"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                  {!list.length && <li className="py-1 text-xs text-muted">Belum ada faktor.</li>}
                </ul>
                <div className="border-t border-border px-3 py-1.5">
                  <button type="button" onClick={() => update([...rows, { key: newKey(), quadrant: q, text: "" }])} className="text-xs font-medium text-primary hover:underline">
                    + Tambah {label.toLowerCase()}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
    <GoldComparison rows={rows} outputs={outputs} />
    </div>
  );
}

/** Perbandingan otomatis kunci jawaban dengan faktor hasil agen (kemiripan kata; tetap periksa manual). */
function GoldComparison({ rows, outputs }: { rows: Row[]; outputs: GoldOutputs }) {
  const gold = useMemo(
    () =>
      QUADRANTS.flatMap(({ q }) =>
        rows
          .filter((r) => r.quadrant === q && r.text.trim().length >= 2)
          .map((r, i) => ({ id: `${q}${i + 1}`, quadrant: q, text: r.text.trim() })),
      ),
    [rows],
  );
  const agent = useMemo(() => agentFactors(outputs), [outputs]);
  const cmp = useMemo(() => compareGold(gold, agent), [gold, agent]);
  return (
    <Card
      title="Perbandingan dengan hasil agen"
      subtitle="Faktor dari run terakhir proyek ini (analisis Faktor internal dan Faktor eksternal) dicocokkan otomatis dengan kunci jawaban."
    >
      {!agent.length ? (
        <Empty>Belum ada hasil Faktor internal/eksternal di run terakhir proyek ini. Jalankan analisis di canvas dulu.</Empty>
      ) : !gold.length ? (
        <Empty>Isi kunci jawaban dulu.</Empty>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="info">
              Kunci ditemukan agen: {cmp.matches.filter((m) => m.match).length}/{gold.length} ({fmt.pct(cmp.recall)})
            </Badge>
            <Badge tone="info">
              Faktor agen yang cocok kunci: {agent.length - cmp.unmatchedAgent.length}/{agent.length} ({fmt.pct(cmp.precision)})
            </Badge>
          </div>
          <Table head={["Kunci", "Faktor agen paling mirip", "Kemiripan"]}>
            {cmp.matches.map((m) => (
              <tr key={m.gold.id}>
                <td className="max-w-xs">
                  <span className="font-mono text-[11px] font-semibold">{m.gold.id}</span> <span className="text-sm">{m.gold.text}</span>
                </td>
                <td className="max-w-xs text-sm">
                  {m.match ? (
                    <>
                      <span className="font-mono text-[11px] font-semibold">{m.match.id}</span> {m.match.text}
                    </>
                  ) : m.otherQuadrant ? (
                    <span className="text-warn">
                      Ada di kuadran lain ({m.otherQuadrant.id}): {m.otherQuadrant.text}
                    </span>
                  ) : (
                    <span className="text-danger">tidak ditemukan</span>
                  )}
                </td>
                <td className="tabular-nums">{fmt.num(m.score, 2)}</td>
              </tr>
            ))}
          </Table>
          {cmp.unmatchedAgent.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-text">
                {cmp.unmatchedAgent.length} faktor agen tidak cocok dengan kunci (bisa jadi tambahan yang sah, atau karangan)
              </summary>
              <ul className="mt-1.5 space-y-1">
                {cmp.unmatchedAgent.map((a) => (
                  <li key={`${a.source}-${a.id}`}>
                    <span className="font-mono font-semibold">{a.id}</span> {a.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Note>
            Kecocokan dihitung dari kemiripan kata (≥ 0,40 = cocok) — cara cepat, bukan penilaian akhir. Untuk penelitian, tetap nilai manual di tab
            Anotasi.
          </Note>
        </div>
      )}
    </Card>
  );
}
