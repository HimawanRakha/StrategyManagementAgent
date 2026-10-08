"use client";
import { Card, Empty, Loading, Table, Badge } from "@/components/ui";
import { fmt } from "@/lib/client/api";
import { Note, PlacementList, SERIES, WilsonCell, fin, type ParamsResponse } from "./shared";

/** Tab "Prediksi vs nyata": P prediksi model dibandingkan proporsi run bersih (interval Wilson) per experiment_tag. */
export function ComparisonTab({ params }: { params: ParamsResponse | null }) {
  if (!params) return <Loading />;
  const rows = params.comparison;
  if (!rows.length) return <Empty>Belum ada run. Jalankan run dengan experiment tag berbeda per konfigurasi penempatan.</Empty>;
  const withData = rows.filter((r) => r.annotated > 0);

  return (
    <div className="space-y-4">
      <Note>
        P nyata = proporsi run yang semua node-nya diputus bersih (hanya run yang semua node-nya sudah diputus). P prediksi = Π(1 − eᵢ′) memakai
        parameter terukur saat ini dan penempatan run pertama di tag itu. Bila P prediksi berada di dalam interval Wilson P nyata, model konsisten
        dengan data; interval lebar berarti butuh lebih banyak run teranotasi.
      </Note>

      <Card title="Prediksi vs nyata per tag" subtitle="Rentang = interval Wilson 95% P nyata · titik = P nyata · belah ketupat = P prediksi">
        {withData.length === 0 ? (
          <Empty>Belum ada run yang semua node-nya diputus.</Empty>
        ) : (
          <div className="space-y-1">
            <div className="mb-2 flex flex-wrap gap-4 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-full" style={{ background: SERIES[0] }} /> P nyata (rentang = interval 95%)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rotate-45" style={{ background: SERIES[1] }} /> P prediksi
              </span>
            </div>
            {withData.map((r) => {
              const p = fin(r.actual.p);
              const inside = r.predicted >= r.actual.lo && r.predicted <= r.actual.hi;
              return (
                <div key={r.tag} className="grid grid-cols-[minmax(80px,140px)_1fr] items-center gap-3">
                  <div className="truncate text-xs font-medium" title={r.tag}>
                    {r.tag}
                  </div>
                  <div className="relative h-7">
                    <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                    <div
                      className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
                      style={{ left: `${r.actual.lo * 100}%`, width: `${Math.max(0.5, (r.actual.hi - r.actual.lo) * 100)}%`, background: `${SERIES[0]}33` }}
                      title={`Interval 95%: ${fmt.num(r.actual.lo, 3)}–${fmt.num(r.actual.hi, 3)}`}
                    />
                    {Number.isFinite(p) && (
                      <div
                        className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
                        style={{ left: `${p * 100}%`, background: SERIES[0] }}
                        title={`P nyata ${fmt.num(p, 3)} (n=${r.actual.n})`}
                      />
                    )}
                    <div
                      className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 ring-2 ring-surface"
                      style={{ left: `${r.predicted * 100}%`, background: SERIES[1] }}
                      title={`P prediksi ${fmt.num(r.predicted, 3)}${inside ? " (di dalam interval)" : " (di luar interval)"}`}
                    />
                  </div>
                </div>
              );
            })}
            <div className="grid grid-cols-[minmax(80px,140px)_1fr] gap-3">
              <div />
              <div className="relative h-4 text-[10px] text-muted tabular-nums">
                {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                  <span key={t} className="absolute -translate-x-1/2" style={{ left: `${t * 100}%` }}>
                    {t.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Table head={["Tag", "Run", "Teranotasi", "P nyata [95%]", "P prediksi", "Selisih", "Konsisten?", "Penempatan"]}>
        {rows.map((r) => {
          const p = fin(r.actual.p);
          const inside = r.annotated > 0 && r.predicted >= r.actual.lo && r.predicted <= r.actual.hi;
          return (
            <tr key={r.tag} className="tabular-nums">
              <td className="font-medium whitespace-nowrap">{r.tag}</td>
              <td>{r.runs}</td>
              <td>{r.annotated}</td>
              <td>
                <WilsonCell w={r.actual} />
              </td>
              <td className="font-medium">{fmt.num(r.predicted, 3)}</td>
              <td>{Number.isFinite(p) ? fmt.num(r.predicted - p, 3) : "–"}</td>
              <td>{r.annotated === 0 ? <span className="text-muted">–</span> : inside ? <Badge tone="ok">ya</Badge> : <Badge tone="warn">tidak</Badge>}</td>
              <td>
                <PlacementList placement={r.placement} />
              </td>
            </tr>
          );
        })}
      </Table>
    </div>
  );
}
