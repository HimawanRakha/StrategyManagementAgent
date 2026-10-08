import { HttpError, handle, requireProject } from "@/lib/access";
import { extractText } from "@/lib/rag/extract";
import { ingestDocument } from "@/lib/rag/embed";

export const maxDuration = 60;

/** Unggah PDF/DOCX/TXT → ekstrak → chunking → embedding → simpan ke documents dan chunks. */
export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const projectId = String(form.get("projectId") ?? "");
  await requireProject(projectId);
  const isValues = form.get("isValues") === "true";
  const inputNode = String(form.get("inputNode") ?? "") || null; // node input di canvas
  const results = [];
  const files = form.getAll("file").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f);
  const pasted = String(form.get("text") ?? "").trim();
  if (!files.length && !pasted) throw new HttpError(400, "Tidak ada file atau teks");
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) throw new HttpError(413, `${file.name} terlalu besar (maks 15 MB)`);
    const text = await extractText(file.name, Buffer.from(await file.arrayBuffer()));
    if (!text.trim()) throw new HttpError(422, `Tidak ada teks yang bisa diekstrak dari ${file.name} (mungkin hasil pindaian)`);
    const r = await ingestDocument(projectId, file.name, text, isValues, inputNode);
    results.push({ id: r.document.id, filename: file.name, chunks: r.chunks });
  }
  if (pasted) {
    const name = String(form.get("filename") ?? "") || `Teks tempel ${new Date().toLocaleString("id-ID")}.txt`;
    const r = await ingestDocument(projectId, name, pasted, isValues, inputNode);
    results.push({ id: r.document.id, filename: name, chunks: r.chunks });
  }
  return { documents: results };
});
