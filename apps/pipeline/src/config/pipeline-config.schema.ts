import { z } from "zod";
import {
  DEFAULT_LLM_CONCURRENCY,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_NEO4J_AUTH,
  LLM_PROVIDERS,
  LLM_REASONING_EFFORTS,
} from "./pipeline-config.const";

/**
 * 숫자 설정에서만 `KEY=` 를 기본값으로 본다. 공백 문자열은 잘못된 값으로 남겨 검증 오류를 낸다.
 */
function emptyStringToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

const optionalRawText = z.string().optional();

/**
 * 원시 환경변수 계약.
 * `NEO4J_URI` 는 전역 기동 조건이 아니다. DB 명령 진입점에서만 명령 이름과 함께 필수 검사를 수행한다.
 */
export const PipelineEnvSchema = z.object({
  NEO4J_URI: optionalRawText,
  NEO4J_AUTH: z.string().default(DEFAULT_NEO4J_AUTH),
  NEO4J_USER: optionalRawText,
  NEO4J_PASSWORD: optionalRawText,
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default(DEFAULT_LLM_PROVIDER),
  LLM_MODEL: optionalRawText,
  LLM_REASONING_EFFORT: z.enum(LLM_REASONING_EFFORTS).optional(),
  LLM_CONCURRENCY: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().default(DEFAULT_LLM_CONCURRENCY)),
  LLM_TIMEOUT_MS: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().default(DEFAULT_LLM_TIMEOUT_MS)),
  PIPELINE_DATA_DIR: optionalRawText,
});

export interface PipelineConfig {
  neo4j: { uri?: string; user: string; password: string };
  llm: {
    provider: (typeof LLM_PROVIDERS)[number];
    model?: string;
    reasoningEffort?: (typeof LLM_REASONING_EFFORTS)[number];
    concurrency: number;
    timeoutMs: number;
  };
  pipelineDataDir?: string;
}

export interface ValidatedPipelineConfig {
  pipeline: PipelineConfig;
}

export const PipelineConfigSchema = PipelineEnvSchema.transform((env): PipelineConfig => {
  const credentials = resolveNeo4jCredentials(env);
  return {
    neo4j: {
      uri: env.NEO4J_URI,
      user: credentials.user,
      password: credentials.password,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL,
      reasoningEffort: env.LLM_REASONING_EFFORT,
      concurrency: env.LLM_CONCURRENCY,
      timeoutMs: env.LLM_TIMEOUT_MS,
    },
    pipelineDataDir: env.PIPELINE_DATA_DIR,
  };
});

/**
 * ConfigModule 의 검증 훅. 실패하면 예외를 던져 기동을 막는다.
 * 반환값을 PIPELINE_CONFIG 프로바이더가 그대로 쓴다.
 */
export function validatePipelineConfig(env: Record<string, unknown>): ValidatedPipelineConfig {
  const parsed = PipelineConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`파이프라인 환경설정 검증 실패:\n${formatIssues(parsed.error)}`);
  }
  return { pipeline: parsed.data };
}

/**
 * 기존 `neo4jCredentials()` 와 같은 우선순위다.
 * `NEO4J_USER` 와 `NEO4J_PASSWORD` 가 둘 다 있을 때만 쌍이 이기고,
 * 하나라도 빠지면 `NEO4J_AUTH` 경로로 돌아간다.
 */
function resolveNeo4jCredentials(env: z.infer<typeof PipelineEnvSchema>): { user: string; password: string } {
  if (env.NEO4J_USER && env.NEO4J_PASSWORD) {
    return { user: env.NEO4J_USER, password: env.NEO4J_PASSWORD };
  }
  const [user = "neo4j", password = "devloop-password"] = env.NEO4J_AUTH.split("/", 2);
  return { user, password };
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `- ${issue.path.join(".") || "env"}: ${issue.message}`).join("\n");
}
