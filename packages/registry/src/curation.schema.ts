import { z } from "zod";

export const CurationMergeSchema = z
  .object({
    canonical: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).min(1),
    reason: z.string().trim().min(1),
    approvedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
export type CurationMerge = z.infer<typeof CurationMergeSchema>;

export const CurationBlockSchema = z
  .object({
    key: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();
export type CurationBlock = z.infer<typeof CurationBlockSchema>;

export const CurationSchema = z
  .object({
    project: z.string().trim().min(1),
    merges: z.array(CurationMergeSchema),
    blocks: z.array(CurationBlockSchema),
  })
  .strict();
export type Curation = z.infer<typeof CurationSchema>;
