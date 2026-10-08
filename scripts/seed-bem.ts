// npm run seed:bem [-- <projectId>] — menyiapkan proyek "BEM FTEIC ITS":
//  (0) bila canvas masih memakai node bawaan lama → disusun ulang dengan node baru per tab Excel (lib/seed/bem-migrate.ts),
//      lalu hasil run lama diarsipkan (tetap tersimpan sebagai data eksperimen) agar canvas mulai dari awal,
//  (1) dokumen dummy di setiap node input canvas (dokumen dummy lama diganti, bukan ditumpuk),
//  (2) nama/instruksi/bentuk tabel untuk node proses kustom, (3) deskripsi proyek.
// Server harus berjalan (npm run dev); skrip memanggil API-nya agar basis data tidak terkunci dua proses.
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { BEM_CUSTOM, BEM_DESCRIPTION, BEM_DOCS } from "../lib/seed/bem-fteic";
import { SESSION_COOKIE, passwordRequired, sessionToken } from "../lib/session";
import { hasLegacyNodes, migrateBemCanvas } from "../lib/seed/bem-migrate";
import type { WorkflowGraph } from "../lib/db/schema";

const BASE = process.env.SEED_BASE_URL ?? "http://localhost:3000";

type GNode = {
  id: string;
  type: string;
  key?: string;
  label?: string;
  values?: boolean;
  custom?: { name: string; instruction: string; prefix?: string; requireEvidence?: boolean; format?: string; columns?: string[] };
  [k: string]: unknown;
};
type Detail = {
  project: { id: string; name: string; description: string | null };
  canvas: { nodes: GNode[]; edges: unknown[] };
  documents: { id: string; filename: string; input_node: string | null }[];
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (passwordRequired()) headers.set("cookie", `${SESSION_COOKIE}=${await sessionToken()}`);
  const res = await fetch(BASE + path, { ...init, headers });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${(body as { error?: string }).error ?? body}`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function main() {
  let id = process.argv[2];
  if (!id) {
    const { projects } = await call<{ projects: { id: string; name: string }[] }>("/api/projects");
    const p = projects.find((x) => /BEM\s*FTEIC/i.test(x.name));
    if (!p) throw new Error('Proyek "BEM FTEIC ITS" tidak ditemukan. Beri ID proyek: npm run seed:bem -- <projectId>');
    id = p.id;
  }
  let d = await call<Detail>(`/api/projects/${id}`);
  console.log(`Proyek: ${d.project.name} (${id})`);

  // 0. Migrasi canvas lama → node baru per tab Excel; run lama diarsipkan (tetap jadi data eksperimen)
  if (hasLegacyNodes(d.canvas as unknown as WorkflowGraph)) {
    const next = migrateBemCanvas(d.canvas as unknown as WorkflowGraph);
    await call(`/api/projects/${id}/canvas`, json("PUT", { graph: next }));
    const r = await call<{ archivedRunId: string | null }>(`/api/projects/${id}/reset`, { method: "POST" });
    const n = next.nodes.filter((x) => x.type === "process").length;
    console.log(`  ✓ canvas disusun ulang dengan node baru (${n} analisis); run lama ${r.archivedRunId ? "diarsipkan" : "tidak ada"}`);
    d = await call<Detail>(`/api/projects/${id}`);
  }

  // 1. Dokumen dummy per node input
  let uploaded = 0;
  const unmatched: string[] = [];
  const labels = new Map(Object.keys(BEM_DOCS).map((k) => [k.trim().toLowerCase(), k]));
  for (const n of d.canvas.nodes.filter((x) => x.type === "input")) {
    const key = labels.get((n.label ?? "").trim().toLowerCase());
    if (!key) {
      unmatched.push(n.label ?? n.id);
      continue;
    }
    for (const old of d.documents.filter((x) => x.input_node === n.id && x.filename.startsWith("DUMMY")))
      await call(`/api/documents/${old.id}`, { method: "DELETE" });
    const doc = BEM_DOCS[key];
    const form = new FormData();
    form.append("projectId", id);
    form.append("inputNode", n.id);
    form.append("isValues", n.values ? "true" : "false");
    form.append("file", new Blob([doc.text], { type: "text/plain" }), doc.filename);
    const r = await call<{ documents: { chunks: number }[] }>("/api/documents", { method: "POST", body: form });
    uploaded++;
    console.log(`  ✓ ${(n.label ?? "").padEnd(28)} ← ${doc.filename} (${r.documents[0].chunks} potongan)`);
  }
  if (unmatched.length) console.log(`  (node input tanpa data dummy, isi sendiri: ${unmatched.join(", ")})`);

  // 2. Instruksi node proses kustom
  let patched = 0;
  const byName = new Map(Object.entries(BEM_CUSTOM).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const n of d.canvas.nodes) {
    if (n.type !== "process" || !n.custom) continue;
    const patch = byName.get((n.custom.name ?? "").trim().toLowerCase());
    if (!patch) continue;
    n.custom = {
      name: n.custom.name,
      instruction: patch.instruction,
      prefix: patch.prefix,
      requireEvidence: patch.requireEvidence,
      format: patch.format,
      ...(patch.columns ? { columns: patch.columns } : {}),
    };
    patched++;
    console.log(`  ✓ proses kustom "${n.custom.name}" → ${patch.format === "table" ? `tabel ${patch.columns!.length} kolom` : "daftar"}, awalan ${patch.prefix}`);
  }
  const res = await call<{ warnings: { message: string }[] }>(`/api/projects/${id}/canvas`, json("PUT", { graph: d.canvas }));

  // 3. Deskripsi proyek (dipakai AI sebagai konteks organisasi)
  if (!d.project.description) await call(`/api/projects/${id}`, json("PATCH", { description: BEM_DESCRIPTION }));

  console.log(`\nSelesai: ${uploaded} dokumen dummy, ${patched} proses kustom diisi.`);
  console.log(res.warnings.length ? `Peringatan canvas: ${res.warnings.map((w) => w.message).join("; ")}` : "Tidak ada peringatan canvas.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
