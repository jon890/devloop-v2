import { z } from "zod";
import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_REASONING_EFFORT,
  DEFAULT_LLM_TRANSPORT,
  DEFAULT_NEO4J_DATABASE,
  DEFAULT_PORT,
  LLM_PROVIDERS,
  LLM_REASONING_EFFORTS,
  LLM_TRANSPORTS,
} from "./api-config.const";

/** 빈 문자열은 "값 없음"으로 취급한다. `.env` 에 `KEY=` 로 남은 줄이 기본값을 건너뛰지 않게 한다. */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const requiredText = z.preprocess(emptyToUndefined, z.string().trim().min(1));
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

/**
 * 원시 환경변수 계약.
 * 필수 값에는 기본값을 두지 않는다 — 값이 없을 때 조용히 다른 모델·다른 DB 로 도는 사고가 있었다.
 */
export const ApiEnvSchema = z.object({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(DEFAULT_PORT)),
  NEO4J_URI: requiredText,
  NEO4J_DATABASE: z.preprocess(emptyToUndefined, z.string().trim().min(1).default(DEFAULT_NEO4J_DATABASE)),
  NEO4J_AUTH: optionalText,
  NEO4J_USER: optionalText,
  NEO4J_PASSWORD: optionalText,
  // 기본값 codex 는 파이프라인(`?? "codex"`)과 맞춘 값이다.
  // 다만 열거형으로 좁혀 오타(`codexx`)가 조용히 codex 로 흘러가지 않게 한다.
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(LLM_PROVIDERS).default(DEFAULT_LLM_PROVIDER)),
  LLM_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(LLM_TRANSPORTS).optional()),
  QUERY_LLM_MODEL: requiredText,
  LLM_REASONING_EFFORT: z.preprocess(emptyToUndefined, z.enum(LLM_REASONING_EFFORTS).default(DEFAULT_LLM_REASONING_EFFORT)),
});

export interface ApiConfig {
  port: number;
  neo4j: { uri: string; database: string; user: string; password: string };
  llm: {
    provider: (typeof LLM_PROVIDERS)[number];
    transport: (typeof LLM_TRANSPORTS)[number];
    queryModel: string;
    reasoningEffort: (typeof LLM_REASONING_EFFORTS)[number];
  };
}

export const ApiConfigSchema = ApiEnvSchema.transform((env, ctx): ApiConfig => {
  const credentials = resolveNeo4jCredentials(env, ctx);
  const transport = resolveLlmTransport(env.LLM_PROVIDER, env.LLM_TRANSPORT, ctx);
  return {
    port: env.PORT,
    neo4j: {
      uri: env.NEO4J_URI,
      database: env.NEO4J_DATABASE,
      user: credentials.user,
      password: credentials.password,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      transport,
      queryModel: env.QUERY_LLM_MODEL,
      reasoningEffort: env.LLM_REASONING_EFFORT,
    },
  };
});

function resolveLlmTransport(
  provider: (typeof LLM_PROVIDERS)[number],
  configured: (typeof LLM_TRANSPORTS)[number] | undefined,
  ctx: z.RefinementCtx,
): (typeof LLM_TRANSPORTS)[number] {
  const transport = configured ?? (provider === "claude" ? "claude" : DEFAULT_LLM_TRANSPORT);
  if (provider === "claude" && transport !== "claude") {
    fail(ctx, `LLM_PROVIDER=claude 는 LLM_TRANSPORT=claude 와만 함께 쓸 수 있다 (받은 값: ${transport}).`);
  }
  if (provider === "codex" && transport === "claude") {
    fail(ctx, "LLM_TRANSPORT=claude 를 쓰려면 LLM_PROVIDER=claude 여야 한다.");
  }
  return transport;
}

/**
 * ConfigModule 의 검증 훅. 실패하면 예외를 던져 기동을 막는다.
 * 반환값을 API_CONFIG 프로바이더가 그대로 쓴다.
 */
export function validateApiConfig(env: Record<string, unknown>): ApiConfig {
  const parsed = ApiConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`API 환경설정 검증 실패:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Neo4j 자격증명은 두 경로를 받는다.
 * - `NEO4J_USER` 와 `NEO4J_PASSWORD` 쌍 (더 구체적이라 우선한다)
 * - `NEO4J_AUTH` (`user/password`. docker-compose 와 같은 값을 공유한다)
 *
 * 우선순위는 파이프라인의 `neo4jCredentials()` 와 같게 맞췄다.
 * 두 패키지가 서로 다른 순서를 쓰면 그것 자체가 조용한 오작동의 원인이 된다.
 * 다만 폴백 사슬의 끝에 있던 하드코딩 기본 비밀번호는 없앴다 — 자격증명이 없으면 기동을 막는다.
 */
function resolveNeo4jCredentials(env: z.infer<typeof ApiEnvSchema>, ctx: z.RefinementCtx): { user: string; password: string } {
  const hasPair = Boolean(env.NEO4J_USER) || Boolean(env.NEO4J_PASSWORD);
  if (hasPair && (!env.NEO4J_USER || !env.NEO4J_PASSWORD)) {
    fail(ctx, "NEO4J_USER 와 NEO4J_PASSWORD 는 함께 지정해야 한다.");
  }
  if (env.NEO4J_USER && env.NEO4J_PASSWORD) {
    return { user: env.NEO4J_USER, password: env.NEO4J_PASSWORD };
  }

  const fromAuth = parseNeo4jAuth(env.NEO4J_AUTH, ctx);
  if (fromAuth) return fromAuth;

  if (!hasPair && !env.NEO4J_AUTH) {
    fail(ctx, "Neo4j 자격증명이 없다. NEO4J_AUTH(user/password) 또는 NEO4J_USER 와 NEO4J_PASSWORD 를 지정하라.");
  }
  return { user: "", password: "" };
}

function parseNeo4jAuth(value: string | undefined, ctx: z.RefinementCtx): { user: string; password: string } | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  const user = separator >= 0 ? value.slice(0, separator) : "";
  const password = separator >= 0 ? value.slice(separator + 1) : "";
  if (!user || !password) {
    fail(ctx, "NEO4J_AUTH 는 user/password 형식이어야 한다.");
    return undefined;
  }
  return { user, password };
}

function fail(ctx: z.RefinementCtx, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `- ${issue.path.join(".") || "env"}: ${issue.message}`).join("\n");
}
