// Definisi node efektif: definisi bawaan/kustom + pengaturan pengguna dari canvas
// (catatan untuk AI, fokus pencarian, jumlah bukti, pemeriksaan yang dimatikan, aturan pemeriksaan buatan pengguna,
// konteks dari node kustom, dan alasan peninjau bila hasil sebelumnya ditolak).
import type { NodeSettings, ValidatorSettings, WorkflowGraph } from "@/lib/db/schema";
import { getNode } from "@/lib/nodes/registry";
import { isCustomKey, makeCustomNode } from "@/lib/nodes/custom";
import type { NodeDef, NodeKey } from "@/lib/nodes/types";
import { runRules } from "@/lib/validators/rules";
import { engineParents, labelOf, settingsOf } from "./canvas";

const DEPTH: Record<NonNullable<NodeSettings["depth"]>, number> = { sedikit: 0.5, sedang: 1, banyak: 2 };

export type ResolvedNode = {
  def: NodeDef;
  settings: NodeSettings;
  validator: ValidatorSettings | null;
  parents: string[];
  label: string;
};

/** `reviewerNote`: alasan peninjau saat menolak hasil sebelumnya — diteruskan ke AI saat dijalankan ulang. */
export function resolveNode(key: string, graph: WorkflowGraph, reviewerNote?: string | null): ResolvedNode {
  const { settings, validator, custom, label } = settingsOf(graph, key);
  const parents = engineParents(graph, key);
  // Butir induk untuk konteks prompt: sertakan detail (mis. isi kolom tabel) agar analisis berikutnya memakai isi lengkapnya.
  const describe = (k: string, out: unknown) => ({
    label: labelOf(graph, k),
    items: getNode(k)
      .items(out)
      .map((i) => ({ id: i.id, text: i.detail ? `${i.text} — ${i.detail}` : i.text })),
  });

  let base: NodeDef;
  if (isCustomKey(key)) {
    if (!custom?.name || !custom?.instruction) throw new Error("Proses kustom ini belum punya nama dan instruksi (atau sudah dihapus dari canvas).");
    base = makeCustomNode(key, custom, parents, describe);
  } else base = getNode(key);

  const note = settings.note?.trim();
  // Induk lewat panah yang bukan dependensi wajib (mis. node kustom, atau analisis lain yang disambungkan pengguna) → konteks tambahan.
  const customParents = isCustomKey(key) ? [] : parents.filter((p) => isCustomKey(p) || !base.deps.includes(p as NodeKey));
  const activeRules = (validator?.rules ?? []).filter((r) => r.enabled !== false);
  const aiRules = activeRules.filter((r) => r.kind === "ai" && r.text?.trim());

  const def: NodeDef = {
    ...base,
    label,
    queries: base.queries
      ? (ctx) => {
          const mult = DEPTH[settings.depth ?? "sedang"] ?? 1;
          const qs = base.queries!(ctx).map((q) => ({ ...q, k: Math.max(1, Math.round((q.k ?? 8) * mult)) }));
          if (settings.focus?.trim()) qs.push({ focus: "fokus pengguna", text: settings.focus.trim(), k: Math.max(2, Math.round(6 * mult)) });
          return qs;
        }
      : undefined,
    prompt: base.prompt
      ? (ctx) => {
          const p = base.prompt!(ctx);
          const extra = customParents
            .filter((k) => ctx.inputs[k as NodeKey] !== undefined)
            .map((k) => {
              const d = describe(k, ctx.inputs[k as NodeKey]);
              return `## ${d.label}\n${d.items.map((i) => `${i.id}: ${i.text}`).join("\n")}`;
            });
          let system = p.system;
          if (note) system += `\n\nCATATAN TAMBAHAN DARI PENGGUNA (ikuti selama tidak melanggar aturan dan skema di atas):\n${note}`;
          // Aturan validator buatan pengguna disampaikan sejak awal agar hasil langsung memenuhinya.
          if (aiRules.length) system += `\n\nATURAN YANG AKAN DIPERIKSA:\n${aiRules.map((r) => `- ${r.text}`).join("\n")}`;
          if (reviewerNote?.trim()) system += `\n\nHASIL SEBELUMNYA DITOLAK PENINJAU dengan alasan: "${reviewerNote.trim()}". Perbaiki sesuai alasan itu.`;
          // Dokumen dari input yang disambungkan langsung ke node ini; ditambahkan bila prompt dasar belum memuatnya.
          const linked = ctx.evidence.filter((c) => c.focus === "input tersambung" && !p.user.includes(`[${c.id}]`));
          let user = p.user;
          if (linked.length)
            user += `\n\nDokumen dari input yang disambungkan langsung ke analisis ini (jadikan pertimbangan utama; bila dipakai, sebut ID potongannya, mis. [C12]):\n${linked.map((c) => `[${c.id}] (${c.source}) ${c.content}`).join("\n\n")}`;
          if (extra.length) user += `\n\nHasil analisis tambahan dari node yang tersambung (boleh dipakai sebagai konteks):\n${extra.join("\n\n")}`;
          return { system, user };
        }
      : undefined,
    validate:
      base.validate || activeRules.length
        ? async (out, ctx, llm) => {
            const off = new Set(validator?.disabledChecks ?? []);
            const res = base.validate ? await base.validate(out, ctx, Object.assign(Object.create(llm), { disabled: off })) : [];
            const ruleRes = await runRules(activeRules, base.items(out), llm, `Analisis: ${label}`);
            return [...res.filter((c) => !off.has(c.check)), ...ruleRes];
          }
        : undefined,
  };
  return { def, settings, validator, parents, label };
}
