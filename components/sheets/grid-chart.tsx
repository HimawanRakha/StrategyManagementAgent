"use client";
// Grafik yang menyertai sheet: kuadran (titik posisi + label kuadran), batang, dan sebar (mis. effort–impact).
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import type { GridChart } from "@/lib/sheets/grid";
import { formatNumber } from "./grid-utils";

const AXIS = "var(--muted)";
const GRID = "var(--border)";
const n = (x: number) => formatNumber(x, "0.000");

function QuadrantChart({ chart }: { chart: Extract<GridChart, { type: "quadrant" }> }) {
  // Titik pusat 0 (mis. S+W dan O+T); rentang simetris agar keempat kuadran sama besar.
  const lim = Math.max(1, Math.ceil(Math.max(Math.abs(chart.x), Math.abs(chart.y)) * 1.25 * 2) / 2);
  const S = 280;
  const pad = 28;
  const inner = S - pad * 2;
  const px = (x: number) => pad + ((x + lim) / (2 * lim)) * inner;
  const py = (y: number) => pad + ((lim - y) / (2 * lim)) * inner;
  const [ka, kiA, kiB, kaB] = chart.quadrants;
  const qx = chart.x >= 0 ? (chart.y >= 0 ? 0 : 3) : chart.y >= 0 ? 1 : 2;
  const quad = [
    { label: ka, x: px(lim / 2), y: py(lim / 2) },
    { label: kiA, x: px(-lim / 2), y: py(lim / 2) },
    { label: kiB, x: px(-lim / 2), y: py(-lim / 2) },
    { label: kaB, x: px(lim / 2), y: py(-lim / 2) },
  ];
  return (
    <figure className="space-y-1">
      <svg viewBox={`0 0 ${S} ${S}`} className="mx-auto block w-full max-w-[340px]" role="img" aria-label={`${chart.title}: ${chart.xLabel} ${n(chart.x)}, ${chart.yLabel} ${n(chart.y)}`}>
        {quad.map((q, i) => (
          <rect
            key={i}
            x={i === 0 || i === 3 ? px(0) : pad}
            y={i <= 1 ? pad : py(0)}
            width={inner / 2}
            height={inner / 2}
            fill={i === qx ? "var(--primary-soft)" : "transparent"}
            stroke={GRID}
          />
        ))}
        {quad.map((q, i) => (
          <text key={i} x={q.x} y={q.y} textAnchor="middle" dominantBaseline="middle" fontSize="10.5" fill={i === qx ? "var(--primary)" : AXIS} fontWeight={i === qx ? 700 : 400}>
            {q.label.length > 26 ? (
              q.label
                .match(/.{1,22}(\s|$)/g)
                ?.slice(0, 3)
                .map((t, j, a) => (
                  <tspan key={j} x={q.x} dy={j === 0 ? `${-(a.length - 1) * 0.6}em` : "1.2em"}>
                    {t.trim()}
                  </tspan>
                ))
            ) : (
              q.label
            )}
          </text>
        ))}
        <line x1={pad} x2={S - pad} y1={py(0)} y2={py(0)} stroke={AXIS} strokeWidth={1.2} />
        <line x1={px(0)} x2={px(0)} y1={pad} y2={S - pad} stroke={AXIS} strokeWidth={1.2} />
        <text x={S - pad} y={py(0) - 5} textAnchor="end" fontSize="10" fill={AXIS}>
          {chart.xLabel} →
        </text>
        <text x={px(0) + 5} y={pad - 8} fontSize="10" fill={AXIS}>
          ↑ {chart.yLabel}
        </text>
        <text x={pad} y={py(0) + 13} fontSize="9" fill={AXIS}>
          {formatNumber(-lim)}
        </text>
        <text x={S - pad} y={py(0) + 13} textAnchor="end" fontSize="9" fill={AXIS}>
          {formatNumber(lim)}
        </text>
        <line x1={px(0)} y1={py(0)} x2={px(chart.x)} y2={py(chart.y)} stroke="var(--danger)" strokeDasharray="3 3" />
        <circle cx={px(chart.x)} cy={py(chart.y)} r={6} fill="var(--danger)" stroke="var(--surface)" strokeWidth={2} />
        <text x={px(chart.x)} y={py(chart.y) - 10} textAnchor="middle" fontSize="10.5" fontWeight={700} fill="var(--danger)">
          ({n(chart.x)}; {n(chart.y)})
        </text>
      </svg>
      <figcaption className="text-center text-[11.5px] text-muted">
        Titik merah = posisi organisasi ({chart.xLabel} {n(chart.x)}, {chart.yLabel} {n(chart.y)}) → kuadran <b className="text-text">{chart.quadrants[qx]}</b>.
      </figcaption>
    </figure>
  );
}

function TipBox({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs shadow-sm">
      <div className="mb-0.5 font-medium">{title}</div>
      {lines.map((l, i) => (
        <div key={i} className="tabular-nums text-muted">
          {l}
        </div>
      ))}
    </div>
  );
}

function BarsChart({ chart }: { chart: Extract<GridChart, { type: "bar" }> }) {
  const data = chart.data.map((d) => ({ ...d, short: d.label.length > 24 ? `${d.label.slice(0, 22)}…` : d.label }));
  const h = Math.max(120, data.length * 26 + 40);
  return (
    <div style={{ height: h }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" domain={[0, chart.max ?? "auto"]} tick={{ fill: AXIS, fontSize: 11 }} tickFormatter={(v: number) => formatNumber(v)} />
          <YAxis type="category" dataKey="short" width={140} tick={{ fill: AXIS, fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload }) => {
              const p = active && payload?.[0]?.payload;
              return p ? <TipBox title={p.label} lines={[formatNumber(p.value, "0.000")]} /> : null;
            }}
          />
          <Bar dataKey="value" fill="var(--primary)" radius={[0, 3, 3, 0]} isAnimationActive={false}>
            <LabelList dataKey="value" position="right" formatter={(v: unknown) => (typeof v === "number" ? formatNumber(v, "0.000") : "")} style={{ fill: AXIS, fontSize: 11 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ScatterPlot({ chart }: { chart: Extract<GridChart, { type: "scatter" }> }) {
  const max = chart.max ?? Math.max(1, ...chart.points.flatMap((p) => [p.x, p.y]));
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 12, right: 24, bottom: 20, left: 4 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis
            type="number"
            dataKey="x"
            domain={[0, max]}
            name={chart.xLabel}
            tick={{ fill: AXIS, fontSize: 11 }}
            label={{ value: chart.xLabel, position: "insideBottom", offset: -10, fill: AXIS, fontSize: 11 }}
          />
          <YAxis type="number" dataKey="y" domain={[0, max]} name={chart.yLabel} width={40} tick={{ fill: AXIS, fontSize: 11 }} label={{ value: chart.yLabel, angle: -90, position: "insideLeft", fill: AXIS, fontSize: 11 }} />
          <ZAxis range={[60, 60]} />
          {chart.threshold !== undefined && <ReferenceLine x={chart.threshold} stroke="var(--warn)" strokeDasharray="4 3" />}
          {chart.threshold !== undefined && <ReferenceLine y={chart.threshold} stroke="var(--warn)" strokeDasharray="4 3" />}
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              const p = active && payload?.[0]?.payload;
              return p ? <TipBox title={p.label} lines={[`${chart.xLabel}: ${formatNumber(p.x)}`, `${chart.yLabel}: ${formatNumber(p.y)}`]} /> : null;
            }}
          />
          <Scatter data={chart.points} fill="var(--primary)" isAnimationActive={false}>
            {chart.points.map((p, i) => (
              <Cell key={i} fill={chart.threshold !== undefined && p.x >= chart.threshold && p.y >= chart.threshold ? "var(--ok)" : "var(--primary)"} />
            ))}
            <LabelList dataKey="label" position="top" style={{ fill: AXIS, fontSize: 10 }} />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Grafik sheet (judul + gambar). */
export function GridChartView({ chart }: { chart: GridChart }) {
  return (
    <section className="space-y-2 rounded-md border border-border bg-surface p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{chart.title}</h4>
      {chart.type === "quadrant" ? <QuadrantChart chart={chart} /> : chart.type === "bar" ? <BarsChart chart={chart} /> : <ScatterPlot chart={chart} />}
    </section>
  );
}
