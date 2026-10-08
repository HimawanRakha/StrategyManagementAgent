"use client";
import { Suspense, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { WorkflowGraph } from "@/lib/db/schema";
import { Badge, ErrorBox, Field, Loading, PageHeader, Select, cx } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import { ApiErrorNote, isAuthExpired, type ParamsResponse } from "@/components/experiments/shared";
import { BatchTab, canvasKeys, type SelectedProject } from "@/components/experiments/batch-tab";
import { AnnotateTab } from "@/components/experiments/annotate-tab";
import { GoldTab } from "@/components/experiments/gold-tab";
import { ParametersTab } from "@/components/experiments/parameters-tab";
import { VerdictsTab } from "@/components/experiments/verdicts-tab";
import { InjectionTab } from "@/components/experiments/injection-tab";
import { OptimizeTab } from "@/components/experiments/optimize-tab";
import { ComparisonTab } from "@/components/experiments/comparison-tab";
import { SimulateTab } from "@/components/experiments/simulate-tab";

const TABS = [
  { key: "batch", label: "Run batch" },
  { key: "anotasi", label: "Anotasi" },
  { key: "putusan", label: "Putusan" },
  { key: "parameter", label: "Parameter" },
  { key: "injeksi", label: "Penyuntikan galat" },
  { key: "optimasi", label: "Optimasi" },
  { key: "prediksi", label: "Prediksi vs nyata" },
  { key: "simulasi", label: "Simulasi" },
  { key: "kunci", label: "Kunci jawaban" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type ProjectRow = SelectedProject & { orgType: string | null };
type ProjectCanvas = { workflowId: string; canvas: WorkflowGraph; runId: string | null; nodes?: Record<string, { status: string; output: unknown }> };

export default function ExperimentsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <Suspense fallback={<Loading />}>
        <Experiments />
      </Suspense>
    </div>
  );
}

function Experiments() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get("tab");
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : "batch";
  const params = useApi<ParamsResponse>("/api/experiments/parameters");
  const projects = useApi<{ projects: ProjectRow[] }>("/api/projects");

  const list = useMemo(() => projects.data?.projects ?? [], [projects.data]);
  const wanted = sp.get("project");
  const project = list.find((p) => p.id === wanted) ?? list[0] ?? null;
  const detail = useApi<ProjectCanvas>(project ? `/api/projects/${project.id}` : null);
  const simCanvas = detail.data && project ? { workflowId: detail.data.workflowId, projectName: project.name, keys: canvasKeys(detail.data.canvas) } : null;

  const setQuery = (k: string, v: string) => {
    const q = new URLSearchParams(sp.toString());
    q.set(k, v);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const authExpired = isAuthExpired(params.error) || isAuthExpired(projects.error);

  return (
    <div>
      <PageHeader
        title="Eksperimen"
        subtitle="Modul penelitian (TA), terpisah dari pemakaian sehari-hari di canvas. Di sini Anda menjalankan run berulang, menilai output secara buta, lalu mengukur galat tiap tahap dan mencari penempatan validator/tinjauan manusia terbaik."
      />
      {authExpired ? (
        <ApiErrorNote message={params.error ?? projects.error} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface px-4 py-3">
            <Field label="Proyek yang dieksperimenkan" className="min-w-64 flex-1 sm:max-w-md">
              <Select value={project?.id ?? ""} onChange={(e) => setQuery("project", e.target.value)} disabled={!list.length}>
                {!list.length && <option value="">{projects.loading ? "Memuat…" : "Belum ada proyek"}</option>}
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isSynthetic ? " (contoh)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            {project?.isSynthetic && (
              <Badge tone="accent" className="mb-2.5" title="Kasus sintetis dengan kunci jawaban">
                contoh · punya kunci jawaban
              </Badge>
            )}
            <p className="mb-2 text-[11px] text-muted sm:ml-auto sm:max-w-xs">
              Tab Run batch dan Kunci jawaban memakai proyek ini; tab lain menghitung dari semua run eksperimen.
            </p>
            {projects.error && !projects.data && (
              <div className="w-full">
                <ErrorBox error={projects.error} />
              </div>
            )}
          </div>

          <div className="mb-4 overflow-x-auto overflow-y-hidden border-b border-border">
            <nav className="flex min-w-max gap-1" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setQuery("tab", t.key)}
                  className={cx(
                    "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                    tab === t.key ? "border-primary font-medium text-primary" : "border-transparent text-muted hover:text-text",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          {tab === "batch" && <BatchTab project={project} detail={detail} />}
          {tab === "anotasi" && <AnnotateTab />}
          {tab === "putusan" && <VerdictsTab />}
          {params.error && !params.data && (tab === "parameter" || tab === "prediksi") ? (
            <ErrorBox error={`Gagal memuat parameter: ${params.error}`} />
          ) : (
            <>
              {tab === "parameter" && <ParametersTab base={params.data} reloadBase={params.reload} />}
              {tab === "prediksi" && <ComparisonTab params={params.data} />}
            </>
          )}
          {tab === "injeksi" && <InjectionTab />}
          {tab === "optimasi" && <OptimizeTab params={params.data} paramsError={params.error} />}
          {tab === "simulasi" && <SimulateTab params={params.data} canvas={simCanvas} />}
          {tab === "kunci" && (
            <GoldTab
              projectId={project?.id ?? null}
              isSynthetic={!!project?.isSynthetic}
              outputs={{ faktor_internal: detail.data?.nodes?.faktor_internal?.output, faktor_eksternal: detail.data?.nodes?.faktor_eksternal?.output }}
            />
          )}
        </>
      )}
    </div>
  );
}
