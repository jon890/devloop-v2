import { z } from "zod";

/**
 * Phase 01 은 설정 그릇과 .env 주입 경로만 만든다.
 * 실제 값은 Phase 02·03 에서 하나씩 옮기므로 원시 스키마는 의도적으로 비워 둔다.
 */
export const PipelineEnvSchema = z.object({});

export interface PipelineConfig {}

export interface ValidatedPipelineConfig {
  pipeline: PipelineConfig;
}

export const PipelineConfigSchema = PipelineEnvSchema.transform((): PipelineConfig => ({}));

/**
 * ConfigModule 의 검증 훅. 빈 스키마라 현재는 항상 통과하지만,
 * 알 수 없는 환경변수가 PipelineConfig 로 새어 들어오지 않는 것은 고정한다.
 */
export function validatePipelineConfig(env: Record<string, unknown>): ValidatedPipelineConfig {
  const parsed = PipelineConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`파이프라인 환경설정 검증 실패:\n${formatIssues(parsed.error)}`);
  }
  return { pipeline: parsed.data };
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `- ${issue.path.join(".") || "env"}: ${issue.message}`).join("\n");
}
