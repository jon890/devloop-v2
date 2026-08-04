import { resolve } from "node:path";

/** ApiConfig 를 주입받기 위한 DI 토큰. 인터페이스는 Nest 가 주입할 수 없어 심볼을 쓴다. */
export const API_CONFIG = Symbol("API_CONFIG");

/**
 * 저장소 루트.
 * src/config 와 dist/config 모두 루트에서 네 단계 아래라 같은 상대 경로가 성립한다.
 * 상주 `codex app-server` 의 읽기 범위(`cwd`)도 이 경로다.
 */
export const REPO_ROOT = resolve(__dirname, "../../../..");

export const ROOT_ENV_PATH = resolve(REPO_ROOT, ".env");

export const DEFAULT_PORT = 3000;
export const DEFAULT_NEO4J_DATABASE = "neo4j";

export const LLM_PROVIDERS = ["codex", "claude"] as const;
export const DEFAULT_LLM_PROVIDER = "codex";
export const LLM_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
