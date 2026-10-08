"use client";
import { useState } from "react";
import { Card, Empty, ErrorBox, Field, Loading, Select, Stat, Table, Button } from "@/components/ui";
import { fmt, useApi } from "@/lib/client/api";
import { ApiErrorNote, Note, WilsonCell, fin, type ParamsResponse } from "./shared";

/** Tab "Parameter": e, d, r, h, biaya, kappa per tahap dengan interval Wilson. */
export function ParametersTab({ base, reloadBase }: { base: ParamsResponse | null; reloadBase: () => void }) {
  const [tag, setTag] = useState("");
  const own = useApi<ParamsResponse>(tag ? `/api/experiments/parameters?tag=${encodeURIComponent(tag)}` : null);
  const data = tag ? own.data : base;
  const loading = tag ? own.loading : !base;
  const error = tag ? own.error : null;

  if (error && !data) return <ApiErrorNote message={error} />;
  const tags = base?.tags ?? [];
  const withE = data?.stages.filter((s) => s.e.n > 0).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Experiment tag">
          <Select value={tag} onChange={(e) => setTag(e.target.value)} className="min-w-48">
            <option value="">Semua tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" variant="ghost" onClick={() => (tag ? own.reload() : reloadBase())}>
          Muat ulang
        </Button>
      </div>

      <ErrorBox error={error} />
      {loading || !data ? (
        <Loading label="Menghitung parameter…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Cohen's κ keseluruhan" value={fmt.num(fin(data.kappa), 2)} hint={`${data.kappaN} item dinilai dua penilai`} />
            <Stat label="dʰ (deteksi manusia)" value={fmt.num(data.dh, 2)} hint="dari Pengaturan" />
            <Stat
              label="Stabilitas QSPM (Kendall τ)"
              value={data.qspmTau ? fmt.num(data.qspmTau.tau, 2) : "–"}
              hint={data.qspmTau ? `${data.qspmTau.pairs} pasangan run` : "butuh ≥ 2 run QSPM"}
            />
            <Stat label="Tahap dengan data e" value={`${withE} / ${data.stages.length}`} hint="node dengan putusan baseline" />
          </div>

          <Note>
            <b>e</b> diestimasi hanya dari node run <i>baseline</i> (tanpa validator/tinjauan) yang inputnya bersih — yaitu run di mana semua node
            induk berputusan bersih; galat yang terbawa dari induk tidak dihitung sebagai galat sendiri. <b>d</b> dan <b>r</b> berasal dari
            penyuntikan galat (r dihitung dari galat yang terdeteksi), <b>h</b> adalah peluang node memulihkan galat dari input. Angka di bawah
            proporsi adalah interval Wilson 95%; interval yang lebar (oranye) berarti perlu lebih banyak run sebelum dipakai untuk optimasi.
          </Note>

          {data.stages.length === 0 ? (
            <Empty>Belum ada tahap.</Empty>
          ) : (
            <Table
              head={[
                "Tahap",
                "e (galat sendiri)",
                "d (deteksi)",
                "r (perbaikan)",
                "d×r",
                "h (pemulihan)",
                "cᵛ token (n)",
                "cʰ menit (n)",
                "Token generate",
                "κ (n)",
                "Gagal format",
              ]}
            >
              {data.stages.map((s) => (
                <tr key={s.key} className="tabular-nums">
                  <td className="whitespace-nowrap font-medium">{s.label}</td>
                  <td>
                    <WilsonCell w={s.e} />
                  </td>
                  <td>
                    <WilsonCell w={s.d} />
                  </td>
                  <td>
                    <WilsonCell w={s.r} />
                  </td>
                  <td>{s.d.n ? fmt.num(s.dr, 3) : <span className="text-muted">–</span>}</td>
                  <td>
                    <WilsonCell w={s.h} />
                  </td>
                  <td>
                    {s.cTokN ? fmt.int(s.cTok) : "–"} <span className="text-[11px] text-muted">({s.cTokN})</span>
                  </td>
                  <td>
                    {s.cMinN ? fmt.num(s.cMin, 1) : "–"} <span className="text-[11px] text-muted">({s.cMinN})</span>
                  </td>
                  <td>{s.genTok ? fmt.int(s.genTok) : "–"}</td>
                  <td>
                    {fmt.num(fin(s.kappa), 2)} <span className="text-[11px] text-muted">({s.kappaN})</span>
                  </td>
                  <td className={s.formatFailures ? "text-warn" : undefined}>{fmt.int(s.formatFailures)}</td>
                </tr>
              ))}
            </Table>
          )}
          <p className="text-[11px] text-muted">
            Kegagalan format JSON dicatat terpisah dan bukan galat analisis. κ dihitung per tahap dari pasangan dua penilai pada item yang sama.
          </p>
        </>
      )}
      {data && !loading && withE === 0 && (
        <Card title="Belum ada data e">
          <p className="text-sm text-muted">
            Jalankan run baseline, anotasi oleh dua penilai, lalu beri putusan di tab <b>Putusan</b>. Untuk mencoba optimasi tanpa data, pakai
            &ldquo;Muat contoh angka&rdquo; di tab <b>Optimasi</b> (atau biarkan asumsi umum terisi otomatis).
          </p>
        </Card>
      )}
    </div>
  );
}
