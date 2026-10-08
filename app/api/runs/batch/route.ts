import { z } from "zod";
import { handle, projectOfWorkflow, requireProject } from "@/lib/access";
import { createRun } from "@/lib/engine/run-workflow";
import { startAuto } from "@/lib/engine/queue";
import { RunBody } from "@/lib/api-schemas";

const Body = RunBody.extend({ n: z.number().int().min(1).max(100), autoStart: z.boolean().optional() });

/**
 * Membuat N run untuk satu konfigurasi. Dengan autoStart, setiap run dijalankan di antrean;
 * tanpa autoStart, UI menjalankan node demi node lewat /api/runs/[id]/execute.
 */
export const POST = handle(async (req: Request) => {
  const body = Body.parse(await req.json());
  const { user } = await requireProject(await projectOfWorkflow(body.workflowId));
  const runs = [];
  for (let i = 0; i < body.n; i++) {
    const run = await createRun({ ...body, mode: body.autoStart ? "auto" : "manual", createdBy: user.id });
    if (body.autoStart) await startAuto(run.id);
    runs.push(run);
  }
  return { runs };
});
