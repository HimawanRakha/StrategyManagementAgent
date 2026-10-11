"use client";
import { useState, type ReactNode } from "react";
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Textarea } from "@/components/ui";
import { api, fmt, useApi } from "@/lib/client/api";
import { DEFAULT_CODEBOOK } from "@/lib/codebook";

type Settings = {
  model: string;
  temperature: number;
  dh: number;
  codebook: { version: string; text: string };
};
type Env = {
  provider: string;
  defaultModel: string;
  embeddingModel: string;
  embeddingDim: number;
  maxRepair: number;
  geminiKey: boolean;
  groqKey: boolean;
  database: string;
  auth: boolean;
  queue: string;
};
type SettingsResponse = { settings: Settings; env: Env };

export default function SettingsPage() {
  const { data, error, loading } = useApi<SettingsResponse>("/api/settings");
  const expired = !!error && /Silakan masuk|HTTP 401/i.test(error);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
      <PageHeader title="Pengaturan" subtitle="Model AI, parameter eksperimen, dan codebook anotasi. Berlaku untuk semua proyek." />
      {loading && !data ? (
        <Loading label="Memuat pengaturan…" />
      ) : error && !data ? (
        <ErrorBox error={expired ? "Sesi login sudah berakhir. Muat ulang halaman lalu masuk lagi dengan kata sandi tim." : error} />
      ) : data ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <SettingsForm initial={data.settings} env={data.env} />
          <EnvCard env={data.env} />
        </div>
      ) : null}
    </div>
  );
}

function SettingsForm({ initial, env }: { initial: Settings; env: Env }) {
  const [base, setBase] = useState(initial.codebook);
  const [model, setModel] = useState(initial.model ?? "");
  const [temperature, setTemperature] = useState(String(initial.temperature));
  const [dh, setDh] = useState(String(initial.dh));
  const [version, setVersion] = useState(initial.codebook?.version ?? "");
  const [text, setText] = useState(initial.codebook?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const num = (s: string) => (s.trim() === "" ? NaN : Number(s.replace(",", ".")));
  const t = num(temperature);
  const d = num(dh);
  const problems: string[] = [];
  if (!(t >= 0 && t <= 2)) problems.push("Suhu harus 0–2.");
  if (!(d >= 0 && d <= 1)) problems.push("Daya deteksi manusia harus 0–1.");
  if (!version.trim()) problems.push("Versi codebook wajib diisi.");
  if (text.trim().length < 10) problems.push("Teks codebook minimal 10 karakter.");
  const codebookChanged = version !== base?.version || text !== base?.text;
  const versionUnchanged = text !== base?.text && version === base?.version;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api("/api/settings", {
        method: "PUT",
        body: { model: model.trim(), temperature: t, dh: d, codebook: { version: version.trim(), text } },
      });
      setSaved(true);
      setBase({ version: version.trim(), text });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Model LLM" subtitle="Dipakai sebagai bawaan untuk run baru; run yang sudah dibuat menyimpan konfigurasinya sendiri.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model" hint={`Kosongkan untuk memakai bawaan server: ${env.defaultModel || "–"}`}>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={env.defaultModel} className="font-mono" />
          </Field>
          <Field label="Suhu (temperature)" hint="0–2. Nilai rendah (≈0,2) membuat keluaran lebih stabil dan mudah direplikasi.">
            <Input type="number" step="0.05" min={0} max={2} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card
        title="Parameter eksperimen"
        subtitle="Dipakai model propagasi galat dan pengoptimal penempatan validator/tinjauan manusia. Anggaran token dan menit diatur di Laporan run (disarankan otomatis) dan di tab Optimasi."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Daya deteksi manusia (dₕ)" hint="Peluang tinjauan manusia menangkap galat, 0–1. Masih asumsi sampai diukur dari tinjauan sungguhan.">
            <Input type="number" step="0.01" min={0} max={1} value={dh} onChange={(e) => setDh(e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card
        title="Codebook anotasi"
        subtitle="Panduan yang ditampilkan kepada penilai. Naikkan versi setiap kali isi berubah agar anotasi dapat ditelusuri ke versi codebook-nya."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm("Ganti teks codebook dengan versi bawaan? Perubahan belum tersimpan sampai Anda menekan Simpan.")) {
                setText(DEFAULT_CODEBOOK.text);
                setVersion(DEFAULT_CODEBOOK.version);
              }
            }}
          >
            Pulihkan bawaan
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Versi" className="max-w-48">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} className="font-mono" placeholder="v0.2" />
          </Field>
          {versionUnchanged && <div className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">Isi codebook berubah tetapi versinya sama. Sebaiknya naikkan versi.</div>}
          <Field label="Teks" hint={`${fmt.int(text.length)} karakter`}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={22} className="font-mono text-xs leading-relaxed" spellCheck={false} />
          </Field>
        </div>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 rounded-md border border-border bg-surface/95 px-3 py-2.5 backdrop-blur">
        {problems.length > 0 && <span className="mr-auto text-xs text-danger">{problems[0]}</span>}
        {error && <div className="mr-auto w-full sm:w-auto"><ErrorBox error={error} /></div>}
        {saved && !error && <Badge tone="ok">Pengaturan tersimpan</Badge>}
        {codebookChanged && !saved && <Badge tone="warn">codebook diubah</Badge>}
        <Button variant="primary" loading={busy} disabled={problems.length > 0} onClick={save}>
          Simpan pengaturan
        </Button>
      </div>
    </div>
  );
}

function EnvCard({ env }: { env: Env }) {
  const key = (v: boolean) => (v ? <Badge tone="ok">terisi</Badge> : <Badge>kosong</Badge>);
  const rows: [string, ReactNode][] = [
    ["Penyedia LLM", <Badge key="p" tone={env.provider === "mock" ? "warn" : "primary"}>{env.provider}</Badge>],
    ["Model bawaan", <span key="m" className="font-mono text-xs">{env.defaultModel || "–"}</span>],
    ["Model embedding", <span key="e" className="font-mono text-xs">{env.embeddingModel}</span>],
    ["Dimensi embedding", <span key="d" className="tabular-nums">{env.embeddingDim}</span>],
    ["Maks. percobaan perbaikan", <span key="r" className="tabular-nums">{env.maxRepair}</span>],
    ["GEMINI_API_KEY", key(env.geminiKey)],
    ["GROQ_API_KEY", key(env.groqKey)],
    ["Basis data", env.database],
    [
      "Kata sandi tim",
      env.auth ? (
        <Badge key="a" tone="ok" title="APP_PASSWORD terisi: semua orang masuk dengan satu kata sandi tim">
          aktif
        </Badge>
      ) : (
        <Badge key="a" tone="warn" title="APP_PASSWORD kosong: siapa pun yang membuka alamat ini bisa masuk">
          tidak aktif
        </Badge>
      ),
    ],
    ["Antrean", <span key="q" className="font-mono text-xs">{env.queue}</span>],
  ];
  return (
    <div className="space-y-4">
      <Card title="Konfigurasi server" subtitle="Hanya baca; diatur lewat variabel lingkungan.">
        <dl className="divide-y divide-border text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 py-1.5">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <div className="rounded-md bg-info-soft px-3 py-2.5 text-xs leading-relaxed text-info">
        Kata sandi tim diatur lewat <span className="font-mono">APP_PASSWORD</span>. API key hanya disimpan di <span className="font-mono">.env.local</span> (lokal) atau Environment Variables Vercel, dan tidak pernah dikirim ke browser. Halaman ini
        hanya menampilkan apakah key terisi. Ubah nilainya di sana lalu jalankan ulang server.
        {env.provider === "mock" && (
          <span className="mt-1.5 block font-medium">
            Penyedia &ldquo;mock&rdquo; aktif: LLM tiruan tanpa API key, hasil deterministik untuk menguji alur, bukan untuk data penelitian.
          </span>
        )}
      </div>
    </div>
  );
}
