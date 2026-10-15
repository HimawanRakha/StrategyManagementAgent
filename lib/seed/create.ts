import "server-only";
import { getDb, schema } from "@/lib/db/client";
import { ingestDocument } from "@/lib/rag/embed";
import { templateGraph } from "@/lib/engine/canvas";
import { SYNTHETIC_DOCUMENTS, SYNTHETIC_GOLD, SYNTHETIC_PROJECT } from "./synthetic-case";

// Dokumen sintetis → label node input di templat (lihat templateGraph / INPUT_PRESETS).
const INPUT_LABEL_OF: Record<string, string> = {
  "Struktur Kepengurusan HIMSI 2026.txt": "Struktur & jabatan organisasi",
  "Pihak Eksternal HIMSI 2026.txt": "Pihak eksternal",
  "Notulensi Rapat Evaluasi 12 Mei 2026.txt": "Notulensi rapat",
  "LPJ Kepengurusan 2025.txt": "LPJ / laporan kegiatan",
  "Survei Kepuasan Anggota 2026.txt": "Survei anggota",
  "Kondisi Eksternal Kampus 2026.txt": "Kondisi eksternal",
  "Penilaian Stakeholder HIMSI 2026.txt": "Penilaian stakeholder",
  "AD ART dan Nilai Organisasi.txt": "Nilai organisasi (AD/ART)",
};

/** Buat kasus sintetis contoh: proyek, canvas alur lengkap, dokumen di node input, dan kunci jawaban. */
export async function createSyntheticCase(createdBy?: string) {
  const db = await getDb();
  const [project] = await db
    .insert(schema.projects)
    .values({ ...SYNTHETIC_PROJECT, isSynthetic: true, createdBy })
    .returning();
  const graph = templateGraph("full");
  await db.insert(schema.workflows).values({ projectId: project.id, name: "Alur berpikir", graph });
  const inputOf = (filename: string) => graph.nodes.find((n) => n.type === "input" && n.label === INPUT_LABEL_OF[filename])?.id ?? null;
  for (const d of SYNTHETIC_DOCUMENTS) await ingestDocument(project.id, d.filename, d.text, !!d.isValues, inputOf(d.filename), true);
  await db.insert(schema.goldFactors).values(SYNTHETIC_GOLD.map((g) => ({ ...g, projectId: project.id })));
  return project;
}
