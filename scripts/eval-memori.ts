// npm run eval:memori — membandingkan run "baseline" (tanpa memori inti) dengan run "memori" (dengan memori inti
// organisasi). Keduanya tanpa validator/tinjauan dan memakai pencarian vektor yang sama. Hasil: hasil-eksperimen/rag/memori.json.
// Metrik:
//   - dokumen bersih & bagian keliru (putusan dua penilai AI)
//   - klaim tanpa dukungan dokumen (konsensus dua penilai AI)
//   - keselarasan: rujukan ke ID konteks strategis (faktor S/W/O/T, strategi SO/WO/ST/WT) di analisis hilir (MSDM, DM-CRM,
//     renstra, kontinuitas proker), dibedakan rujukan SAH (ID ada di run itu) dan rujukan TIDAK SAH (ID tidak ada)
//   - token masuk/keluar per run dan panjang memori
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const PROJECT = process.env.EKSP_PROJECT ?? "94023829-4c5b-41ce-8809-7674e8a39c7d";
const TAGS = ["baseline", "memori"];
const DOWNSTREAM = /^(msdm_|decision_making|change_management|risk_management|renstra|kontinuitas_proker)/;

async function main() {
  const { queryRows } = await import("../lib/db/client");
  const { sql } = await import("drizzle-orm");
  const { wilson } = await import("../lib/experiment/wilson");
  const tagList = sql.join(TAGS.map((t) => sql`${t}`), sql`, `);
  const runs = await queryRows<{ id: string; tag: string }>(sql`
    SELECT r.id, r.experiment_tag AS tag FROM runs r JOIN workflows w ON w.id = r.workflow_id
    WHERE w.project_id = ${PROJECT} AND r.experiment_tag IN (${tagList}) ORDER BY r.created_at`);
  const verdicts = await queryRows<{ run_id: string; node_key: string; own: boolean; carried: boolean }>(sql`
    SELECT nr.run_id, nr.node_key, v.own_error AS own, v.carried_error AS carried
    FROM node_run_verdicts v JOIN node_runs nr ON nr.id = v.node_run_id WHERE nr.run_id IN (${sql.join(runs.map((r) => sql`${r.id}::uuid`), sql`, `)})`);
  const unsupported = await queryRows<{ run_id: string; n: number; uns: number }>(sql`
    WITH k AS (
      SELECT an.node_run_id, an.item_id, bool_and(an.is_error AND an.error_type = 'unsupported') AS uns, bool_and(an.is_error) AS err
      FROM annotations an WHERE an.annotator LIKE 'AI-judge%' GROUP BY 1, 2 HAVING count(*) = 2)
    SELECT nr.run_id, count(*)::int AS n, count(*) FILTER (WHERE uns)::int AS uns
    FROM k JOIN node_runs nr ON nr.id = k.node_run_id WHERE nr.run_id IN (${sql.join(runs.map((r) => sql`${r.id}::uuid`), sql`, `)}) GROUP BY 1`);
  const outputs = await queryRows<{ run_id: string; node_key: string; output: unknown; memory: string | null }>(sql`
    SELECT nr.run_id, nr.node_key, nr.output, nr.input->>'memory' AS memory FROM node_runs nr
    WHERE nr.status = 'done' AND nr.run_id IN (${sql.join(runs.map((r) => sql`${r.id}::uuid`), sql`, `)})`);
  const tokens = await queryRows<{ run_id: string; tin: number; tout: number }>(sql`
    SELECT nr.run_id, sum(c.tokens_in)::int AS tin, sum(c.tokens_out)::int AS tout FROM llm_calls c JOIN node_runs nr ON nr.id = c.node_run_id
    WHERE c.purpose = 'generate' AND nr.run_id IN (${sql.join(runs.map((r) => sql`${r.id}::uuid`), sql`, `)}) GROUP BY 1`);

  const res: Record<string, unknown> = {};
  for (const tag of TAGS) {
    const ids = runs.filter((r) => r.tag === tag).map((r) => r.id);
    const v = verdicts.filter((x) => ids.includes(x.run_id));
    const judged = ids.filter((id) => v.some((x) => x.run_id === id));
    const clean = judged.filter((id) => v.filter((x) => x.run_id === id).every((x) => !x.own && !x.carried)).length;
    const bad = v.filter((x) => x.own).length;
    const perNode: Record<string, number> = {};
    for (const x of v.filter((y) => y.own)) perNode[x.node_key] = (perNode[x.node_key] ?? 0) + 1;
    const u = unsupported.filter((x) => ids.includes(x.run_id));
    const items = u.reduce((a, x) => a + x.n, 0);
    const uns = u.reduce((a, x) => a + x.uns, 0);
    // Keselarasan analisis hilir dengan konteks strategis.
    let valid = 0, invalid = 0, nodes = 0, withRef = 0;
    for (const id of ids) {
      const outs = outputs.filter((o) => o.run_id === id);
      const known = new Set<string>();
      for (const o of outs.filter((x) => /^(faktor_|swot_matrix|qspm)/.test(x.node_key))) for (const m of JSON.stringify(o.output).matchAll(/"id"\s*:\s*"((?:SO|WO|ST|WT|S|W|O|T)\d+)"/g)) known.add(m[1]);
      for (const o of outs.filter((x) => DOWNSTREAM.test(x.node_key))) {
        nodes++;
        const refs = [...JSON.stringify(o.output).matchAll(/\b((?:SO|WO|ST|WT|S|W|O|T)\d{1,2})\b/g)].map((m) => m[1]);
        const ok = refs.filter((r) => known.has(r)).length;
        valid += ok;
        invalid += refs.length - ok;
        if (ok) withRef++;
      }
    }
    const tk = tokens.filter((x) => ids.includes(x.run_id));
    const mem = outputs.filter((o) => ids.includes(o.run_id) && o.memory).map((o) => o.memory!.length);
    res[tag] = {
      run: ids.length,
      diputus: judged.length,
      dokumenBersih: clean,
      wilson: wilson(clean, judged.length),
      bagianKeliru: bad,
      kelirPerAnalisis: perNode,
      butirDinilai: items,
      klaimTanpaDukungan: uns,
      porsiTanpaDukungan: items ? uns / items : null,
      analisisHilir: nodes,
      analisisHilirMerujukKonteks: withRef,
      porsiMerujuk: nodes ? withRef / nodes : null,
      rujukanSahPerAnalisis: nodes ? valid / nodes : null,
      rujukanTidakSah: invalid,
      tokenMasukPerRun: tk.length ? tk.reduce((a, x) => a + x.tin, 0) / tk.length : null,
      tokenKeluarPerRun: tk.length ? tk.reduce((a, x) => a + x.tout, 0) / tk.length : null,
      memoriRataKarakter: mem.length ? mem.reduce((a, b) => a + b, 0) / mem.length : 0,
      analisisBermemori: mem.length,
    };
  }
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync("hasil-eksperimen/rag", { recursive: true });
  writeFileSync("hasil-eksperimen/rag/memori.json", JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
