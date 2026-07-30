import { resolve } from "node:path";

/** PipelineConfig 를 주입받기 위한 DI 토큰. 인터페이스는 Nest 가 주입할 수 없어 심볼을 쓴다. */
export const PIPELINE_CONFIG = Symbol("PIPELINE_CONFIG");

/**
 * 저장소 루트의 .env 경로.
 * src/config 와 dist/config 모두 루트에서 네 단계 아래라 같은 상대 경로가 성립한다.
 */
export const ROOT_ENV_PATH = resolve(__dirname, "../../../..", ".env");
