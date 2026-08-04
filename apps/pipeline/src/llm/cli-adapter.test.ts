import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeArgs } from "./claude-cli.adapter";

// codex 경로의 계약 검증은 `@devloop/llm` 이 갖는다. 여기에는 자식 프로세스 CLI 만 남는다.

test("Claude CLI 인자는 모델이 없으면 거부한다", () => {
  assert.throws(() => buildClaudeArgs(), /ClaudeCliAdapter.*LLM_MODEL/);
});

test("Claude CLI 인자는 모델이 있으면 --model 을 붙인다", () => {
  const args = buildClaudeArgs({ model: "claude-sonnet" });

  assert.deepEqual(args, ["-p", "--output-format", "json", "--model", "claude-sonnet"]);
});
