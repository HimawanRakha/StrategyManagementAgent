// Indeks butir semua analisis (ID → teks) dari items() tiap node, untuk tooltip rujukan dan panel bukti.
import { getNode } from "@/lib/nodes/registry";
import type { Evidence } from "@/lib/nodes/schemas";

export type IndexedItem = { key: string; text: string; detail?: string; evidence?: Evidence[] };

const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** Bukti kutipan yang tersimpan langsung di butir output (mis. node kustom: items[].evidence). */
function evidenceById(output: unknown): Map<string, Evidence[]> {
  const m = new Map<string, Evidence[]>();
  const items = output && typeof output === "object" ? (output as { items?: unknown }).items : undefined;
  for (const it of arr(items)) {
    const o = it as { id?: unknown; evidence?: unknown };
    if (typeof o?.id === "string" && Array.isArray(o.evidence)) m.set(o.id, o.evidence as Evidence[]);
  }
  return m;
}

/** Peta ID butir → {analisis, teks, keterangan, bukti}. ID ganda: yang pertama dipakai. */
export function itemIndexFrom(outputs: Record<string, unknown>): Map<string, IndexedItem> {
  const m = new Map<string, IndexedItem>();
  for (const [key, out] of Object.entries(outputs)) {
    if (out === null || out === undefined) continue;
    try {
      const ev = evidenceById(out);
      for (const it of getNode(key).items(out) ?? []) {
        if (!it?.id || m.has(it.id)) continue;
        m.set(it.id, { key, text: it.text, detail: it.detail, evidence: ev.get(it.id) });
      }
    } catch {
      /* hasil lama/tidak lengkap: lewati */
    }
  }
  return m;
}
