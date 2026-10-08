// Skema Zod untuk body API yang dipakai lebih dari satu route.
import { z } from "zod";

export const GraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().optional(), // graf lama hanya punya key
      type: z.enum(["input", "process", "output", "validator", "review", "note"]).optional(),
      key: z.string().optional(),
      label: z.string().optional(),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      validator: z.boolean().optional(),
      human: z.boolean().optional(),
      values: z.boolean().optional(),
      text: z.string().max(5000).optional(),
      settings: z
        .object({
          note: z.string().max(4000).optional(),
          focus: z.string().max(500).optional(),
          depth: z.enum(["sedikit", "sedang", "banyak"]).optional(),
          sourceScope: z.enum(["tersambung", "semua"]).optional(),
          temperature: z.number().min(0).max(1).optional(),
          model: z.string().max(100).optional(),
          disabledChecks: z.array(z.string()).optional(),
          maxRepair: z.number().int().min(0).max(3).optional(),
          rules: z
            .array(
              z.object({
                id: z.string().max(60),
                kind: z.enum(["ai", "contains", "not_contains", "measurable", "min_items", "max_items"]),
                text: z.string().max(600).optional(),
                value: z.number().int().min(0).max(200).optional(),
                enabled: z.boolean().optional(),
              }),
            )
            .max(20)
            .optional(),
        })
        .optional(),
      custom: z
        .object({
          name: z.string().max(120),
          instruction: z.string().max(4000),
          prefix: z.string().max(4).optional(),
          requireEvidence: z.boolean().optional(),
          format: z.enum(["list", "table"]).optional(),
          columns: z.array(z.string().max(60)).max(8).optional(),
        })
        .optional(),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
});

export const PlacementSchema = z.record(z.string(), z.object({ validator: z.boolean(), human: z.boolean() }));

export const RunBody = z.object({
  workflowId: z.string().uuid(),
  experimentTag: z.string().min(1).default("baseline"),
  placement: PlacementSchema.optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  mode: z.enum(["manual", "auto"]).optional(),
});
