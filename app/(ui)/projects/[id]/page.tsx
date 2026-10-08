"use client";
// Halaman utama proyek: canvas alur berpikir (input → proses → output) dengan satu panel samping.
import { useParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";
import { ErrorBox, LinkButton, Loading } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import { CanvasEditor } from "@/components/canvas/editor";
import type { ProjectData } from "@/components/canvas/types";

export default function ProjectCanvasPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload, setData } = useApi<ProjectData>(`/api/projects/${id}`);

  if (!data) {
    if (error)
      return (
        <div className="mx-auto w-full max-w-lg space-y-4 p-6">
          <ErrorBox error={error} />
          <LinkButton href="/projects">Kembali ke daftar proyek</LinkButton>
        </div>
      );
    return <Loading label="Memuat proyek…" />;
  }

  return (
    <ReactFlowProvider>
      <CanvasEditor key={id} projectId={id} data={data} reload={reload} onData={setData} />
    </ReactFlowProvider>
  );
}
