// Aturan pemeriksaan buatan pengguna (elemen validator di canvas). Diterapkan pada daftar butir hasil node.
import type { ValidatorRule } from "@/lib/db/schema";
import type { AnnotItem, CheckResult, Failure, LlmSession } from "@/lib/nodes/types";
import { isMeasurable, llmJudge, result } from "./common";

const words = (s?: string) =>
  (s ?? "")
    .split(/[,;\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

/** Label yang mudah dibaca untuk sebuah aturan (ditampilkan di panel validator dan riwayat). */
export function ruleLabel(r: ValidatorRule): string {
  switch (r.kind) {
    case "ai":
      return `Aturan: ${r.text ?? ""}`;
    case "contains":
      return `Wajib memuat salah satu: ${words(r.text).join(", ")}`;
    case "not_contains":
      return `Tidak boleh memuat: ${words(r.text).join(", ")}`;
    case "measurable":
      return "Setiap butir memuat ukuran (angka/persen/jumlah)";
    case "min_items":
      return `Minimal ${r.value ?? 1} butir`;
    case "max_items":
      return `Maksimal ${r.value ?? 10} butir`;
  }
}

export const ruleCheckName = (r: ValidatorRule) => `aturan:${r.id}`;

/** Jalankan aturan aktif terhadap butir hasil node. */
export async function runRules(rules: ValidatorRule[], items: AnnotItem[], llm: LlmSession, context: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const full = (i: AnnotItem) => `${i.text} ${i.detail ?? ""}`.toLowerCase();
  for (const r of rules) {
    if (r.enabled === false) continue;
    const check = ruleCheckName(r);
    const label = ruleLabel(r);
    let failures: Failure[] = [];
    switch (r.kind) {
      case "ai": {
        if (!r.text?.trim()) continue;
        const res = await llmJudge(llm, check, `Periksa apakah setiap butir memenuhi aturan pengguna: "${r.text}".`, items, context);
        failures = res.failures.map((f) => ({ ...f, message: `${f.itemId} melanggar aturan "${r.text}": ${f.message.split(": ").slice(1).join(": ") || "tidak sesuai"}` }));
        out.push({ ...res, failures, passed: !failures.length, label });
        continue;
      }
      case "contains": {
        const ws = words(r.text);
        if (!ws.length) continue;
        failures = items.filter((i) => !ws.some((w) => full(i).includes(w))).map((i) => ({ check, itemId: i.id, message: `${i.id} harus memuat salah satu kata: ${ws.join(", ")}.` }));
        break;
      }
      case "not_contains": {
        const ws = words(r.text);
        if (!ws.length) continue;
        failures = items
          .filter((i) => ws.some((w) => full(i).includes(w)))
          .map((i) => ({ check, itemId: i.id, message: `${i.id} memuat kata terlarang (${ws.filter((w) => full(i).includes(w)).join(", ")}).` }));
        break;
      }
      case "measurable":
        failures = items.filter((i) => !isMeasurable(`${i.text} ${i.detail ?? ""}`)).map((i) => ({ check, itemId: i.id, message: `${i.id} belum memuat ukuran (angka, persentase, atau jumlah).` }));
        break;
      case "min_items":
        if (items.length < (r.value ?? 1)) failures = [{ check, message: `Jumlah butir ${items.length}, minimal ${r.value ?? 1}. Tambahkan butir yang didukung bukti.` }];
        break;
      case "max_items":
        if (items.length > (r.value ?? 10)) failures = [{ check, message: `Jumlah butir ${items.length}, maksimal ${r.value ?? 10}. Pilih butir yang paling penting.` }];
        break;
    }
    out.push({ ...result(check, "code", failures), label });
  }
  return out;
}
