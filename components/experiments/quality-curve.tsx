"use client";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Empty } from "@/components/ui";
import { fmt } from "@/lib/client/api";
import { CHART_AXIS, CHART_GRID, SERIES } from "./shared";

type R = { budgetTokens: number; budgetMinutes: number; predictedP: number; baselineP: number };

/** Kurva kualitas vs. anggaran: x = anggaran menit, y = P prediksi, satu garis per anggaran token. */
export function QualityCurve({ results }: { results: R[] }) {
  const tokens = [...new Set(results.map((r) => r.budgetTokens))].sort((a, b) => a - b);
  const minutes = [...new Set(results.map((r) => r.budgetMinutes))].sort((a, b) => a - b);
  const baseline = results[0]?.baselineP;
  const data = minutes.map((m) => {
    const row: Record<string, number> = { minutes: m };
    for (const t of tokens) {
      const r = results.find((x) => x.budgetMinutes === m && x.budgetTokens === t);
      if (r) row[`t${t}`] = r.predictedP;
    }
    return row;
  });
  const lo = Math.min(...results.map((r) => r.predictedP), baseline ?? 1);
  const yMin = Math.max(0, Math.floor((lo - 0.02) * 20) / 20);
  const shown = tokens.slice(0, SERIES.length);

  return (
    <Card title="Kurva kualitas vs. anggaran" subtitle="P prediksi (dokumen akhir bebas galat) terhadap anggaran menit tinjauan; satu garis per anggaran token.">
      {minutes.length < 2 ? (
        <Empty>Isi minimal dua nilai anggaran menit untuk menggambar kurva.</Empty>
      ) : (
        <>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={CHART_GRID} strokeWidth={1} vertical={false} />
                <XAxis
                  dataKey="minutes"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  ticks={minutes}
                  tick={{ fontSize: 11, fill: CHART_AXIS }}
                  stroke={CHART_GRID}
                  label={{ value: "Anggaran menit", position: "insideBottom", offset: -4, fontSize: 11, fill: CHART_AXIS }}
                  height={36}
                />
                <YAxis
                  domain={[yMin, 1]}
                  tick={{ fontSize: 11, fill: CHART_AXIS }}
                  stroke={CHART_GRID}
                  tickFormatter={(v: number) => v.toFixed(2)}
                  width={44}
                />
                {baseline !== undefined && (
                  <ReferenceLine
                    y={baseline}
                    stroke={CHART_AXIS}
                    strokeWidth={1}
                    label={{ value: `tanpa cek ${baseline.toFixed(3)}`, position: "insideBottomRight", fontSize: 10, fill: CHART_AXIS }}
                  />
                )}
                <Tooltip
                  content={({ active, payload, label }) =>
                    active && payload?.length ? (
                      <div className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs shadow-sm">
                        <div className="mb-1 font-medium">{label} menit</div>
                        {payload.map((p) => (
                          <div key={String(p.dataKey)} className="flex items-center gap-2 tabular-nums">
                            <span className="inline-block h-0.5 w-3 rounded" style={{ background: p.color }} />
                            <span className="text-muted">{String(p.name)}</span>
                            <span className="ml-auto font-medium">{fmt.num(Number(p.value), 3)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null
                  }
                />
                <Legend wrapperStyle={{ fontSize: 11, color: CHART_AXIS }} iconType="plainline" />
                {shown.map((t, i) => (
                  <Line
                    key={t}
                    type="linear"
                    dataKey={`t${t}`}
                    name={`${fmt.int(t)} token`}
                    stroke={SERIES[i]}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    dot={{ r: 4, fill: SERIES[i], stroke: "#ffffff", strokeWidth: 2 }}
                    activeDot={{ r: 5, stroke: "#ffffff", strokeWidth: 2 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {tokens.length > SERIES.length && <p className="mt-1 text-[11px] text-muted">Hanya {SERIES.length} anggaran token pertama yang digambar; semua ada di tabel.</p>}
        </>
      )}
    </Card>
  );
}
