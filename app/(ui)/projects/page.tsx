"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Select, Spinner, Textarea } from "@/components/ui";
import { api, fmt, useApi } from "@/lib/client/api";
import { ORG_TYPES, type Project } from "@/components/projects/types";

export default function ProjectsPage() {
  const router = useRouter();
  const { data, error, loading, reload } = useApi<{ projects: Project[] }>("/api/projects");
  const [showForm, setShowForm] = useState(false);
  const [synthBusy, setSynthBusy] = useState(false);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function createSynthetic() {
    setSynthBusy(true);
    setSynthError(null);
    try {
      const { project } = await api<{ project: Project }>("/api/projects", { body: { template: "synthetic" } });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setSynthError((e as Error).message);
      setSynthBusy(false);
    }
  }

  async function remove(p: Project) {
    if (!window.confirm(`Hapus proyek "${p.name}" beserta dokumen, canvas, dan seluruh hasilnya? Tindakan ini tidak bisa dibatalkan.`)) return;
    setActionError(null);
    try {
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  const projects = data?.projects ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
      <PageHeader
        title="Proyek"
        subtitle="Satu proyek = satu organisasi yang direncanakan strateginya. Buka proyek untuk menyusun alur berpikir di canvas."
        actions={
          <>
            <Button onClick={createSynthetic} loading={synthBusy} title="Membuat organisasi fiktif lengkap dengan dokumen untuk dicoba">
              Coba contoh (kasus sintetis)
            </Button>
            <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Tutup formulir" : "Proyek baru"}
            </Button>
          </>
        }
      />

      {synthBusy && (
        <div className="flex items-start gap-3 rounded-md border border-info/20 bg-info-soft px-3 py-2.5 text-sm text-info">
          <Spinner className="mt-0.5" />
          <div>
            <div className="font-medium">Menyiapkan contoh…</div>
            <div className="text-xs">Membuat organisasi fiktif beserta dokumennya. Biasanya 10–60 detik; jangan tutup halaman ini.</div>
          </div>
        </div>
      )}
      <ErrorBox error={synthError} />
      <ErrorBox error={actionError} />

      {showForm && <NewProjectForm onCancel={() => setShowForm(false)} />}

      {loading && !data ? (
        <Loading label="Memuat proyek…" />
      ) : error && !data ? (
        <ErrorBox error={error} />
      ) : projects.length === 0 ? (
        <Empty
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => setShowForm(true)}>
                Proyek baru
              </Button>
              <Button onClick={createSynthetic} loading={synthBusy}>
                Coba contoh (kasus sintetis)
              </Button>
            </div>
          }
        >
          <p className="font-medium text-text">Belum ada proyek</p>
          <p className="mt-1 max-w-md">
            Buat proyek untuk organisasi Anda, atau coba contoh yang sudah berisi dokumen agar bisa langsung melihat cara kerja agen.
          </p>
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} onDelete={() => remove(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p, onDelete }: { p: Project; onDelete: () => void }) {
  return (
    <div className="group relative flex flex-col rounded-lg border border-border bg-surface transition-colors hover:border-primary/50 hover:shadow-sm">
      <Link href={`/projects/${p.id}`} className="flex flex-1 flex-col p-4 pr-10">
        <div className="flex items-start gap-2">
          <h2 className="font-semibold leading-snug group-hover:text-primary">{p.name}</h2>
          {p.isSynthetic && (
            <Badge tone="accent" title="Kasus sintetis (organisasi fiktif) untuk mencoba aplikasi">
              contoh
            </Badge>
          )}
        </div>
        {p.orgType && <div className="mt-1 text-xs font-medium text-muted">{p.orgType}</div>}
        <p className="mt-2 line-clamp-3 flex-1 text-sm text-muted">{p.description || <span className="italic">Tanpa deskripsi.</span>}</p>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted">
          <span>{fmt.date(p.createdAt)}</span>
          <span className="font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">Buka canvas →</span>
        </div>
      </Link>
      <CardMenu name={p.name} onDelete={onDelete} />
    </div>
  );
}

/** Menu kecil (⋯) di pojok kartu proyek. */
function CardMenu({ name, onDelete }: { name: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="absolute top-2 right-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
        aria-label={`Menu proyek ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-border bg-surface py-1 shadow-lg">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-danger hover:bg-danger-soft"
          >
            Hapus proyek
          </button>
        </div>
      )}
    </div>
  );
}

function NewProjectForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [orgType, setOrgType] = useState<string>("ormawa");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api<{ project: Project }>("/api/projects", {
        body: { name: name.trim(), orgType, description: description.trim() || null },
      });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card title="Proyek baru" subtitle="Anda akan langsung masuk ke canvas alur berpikir yang masih kosong.">
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
        <Field label="Nama proyek / organisasi">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. BEM Fakultas Teknik 2026" autoFocus required minLength={2} />
        </Field>
        <Field label="Jenis organisasi">
          <Select value={orgType} onChange={(e) => setOrgType(e.target.value)}>
            {ORG_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Deskripsi (opsional)" className="md:col-span-2" hint="Konteks singkat, mis. ruang lingkup dan periode perencanaan.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <div className="md:col-span-2">
          <ErrorBox error={error} />
        </div>
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Batal
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={name.trim().length < 2}>
            Buat dan buka canvas
          </Button>
        </div>
      </form>
    </Card>
  );
}
