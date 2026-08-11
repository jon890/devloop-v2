import { MEMORY_CONFIDENCES, MEMORY_KINDS, MEMORY_STATUSES } from "@devloop/shared";
import { z } from "zod";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ExperienceDraftSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/[\r\n]/.test(value), "title은 한 줄이어야 합니다."),
    kind: z.enum(MEMORY_KINDS),
    status: z.enum(MEMORY_STATUSES),
    confidence: z.enum(MEMORY_CONFIDENCES),
    summary: z.string().trim().min(1),
    why: z.string().trim().min(1),
    doNot: z.array(z.string().trim().min(1)),
    scope: z
      .object({
        project: z.string().trim().min(1),
        repositories: z.array(z.string().trim().min(1)),
        modules: z.array(z.string().trim().min(1)),
        paths: z.array(z.string().trim().min(1)),
      })
      .strict(),
    validFrom: DateSchema,
    validUntil: DateSchema.nullable(),
    lastVerified: DateSchema,
    relatedTerms: z.array(z.string().trim().min(1)),
    sourceRefKeys: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();
export type ExperienceDraft = z.infer<typeof ExperienceDraftSchema>;

export const ExperienceExtractionOutputSchema = z
  .object({
    memories: z.array(ExperienceDraftSchema),
  })
  .strict();
export type ExperienceExtractionOutput = z.infer<typeof ExperienceExtractionOutputSchema>;
