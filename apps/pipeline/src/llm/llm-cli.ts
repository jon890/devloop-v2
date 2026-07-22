import { z } from 'zod';

export const LlmOptionsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
});
export type LlmOptions = z.infer<typeof LlmOptionsSchema>;

export const LlmResultSchema = z.object({
  text: z.string(),
  elapsedMs: z.number().nonnegative(),
  tokens: z
    .object({
      in: z.number().int().nonnegative(),
      out: z.number().int().nonnegative(),
    })
    .optional(),
});
export type LlmResult = z.infer<typeof LlmResultSchema>;

export interface LlmCli {
  complete(prompt: string, opts?: LlmOptions): Promise<LlmResult>;
}
