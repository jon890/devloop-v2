import { z } from "zod";

export const LlmReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]);

export const LlmOptionsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  effort: LlmReasoningEffortSchema.optional(),
});
export type LlmOptions = z.infer<typeof LlmOptionsSchema>;
export type LlmReasoningEffort = z.infer<typeof LlmReasoningEffortSchema>;

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
  /**
   * 상주 어댑터만 구현한다. 호출자는 `await cli.close?.()` 로 부르므로 provider 분기가 필요 없다.
   */
  close?(): Promise<void>;
}
