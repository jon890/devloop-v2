import assert from "node:assert/strict";
import test from "node:test";
import { type PipelineConfig } from "../config";
import { maskDatabaseUrl, requireRegistryDatabaseUrl } from "./migrate";

function config(databaseUrl?: string): PipelineConfig {
  return {
    neo4j: { uri: undefined, user: "neo4j", password: "devloop-password" },
    registry: { databaseUrl },
    llm: { provider: "codex", model: undefined, reasoningEffort: undefined, concurrency: 4, timeoutMs: 120_000 },
    pipelineDataDir: undefined,
  };
}

test("migrate-registry 는 REGISTRY_DATABASE_URL 이 없으면 명령 이름과 함께 실패한다", () => {
  assert.throws(() => requireRegistryDatabaseUrl(config(), "migrate-registry"), /migrate-registry requires REGISTRY_DATABASE_URL/);
});

test("migrate-registry 로그 URL 은 자격증명을 숨기고 host 와 port 는 남긴다", () => {
  const masked = maskDatabaseUrl("postgresql://devloop:devloop-password@localhost:15435/devloop_registry");

  assert.equal(masked, "postgresql://***:***@localhost:15435/devloop_registry");
});
