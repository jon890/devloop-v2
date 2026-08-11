import assert from "node:assert/strict";
import test from "node:test";
import type { LlmCompleteOptions, LlmTransport } from "@devloop/llm";
import { AppServerCliAdapter } from "./app-server.adapter";
import { buildClaudeArgs } from "./claude-cli.adapter";
import { ResponsesCliAdapter } from "./responses.adapter";

// codex 경로의 계약 검증은 `@devloop/llm` 이 갖는다. 여기에는 자식 프로세스 CLI 만 남는다.

test("Claude CLI 인자는 모델이 없으면 거부한다", () => {
  assert.throws(() => buildClaudeArgs(), /ClaudeCliAdapter.*LLM_MODEL/);
});

test("Claude CLI 인자는 모델이 있으면 --model 을 붙인다", () => {
  const args = buildClaudeArgs({ model: "claude-sonnet" });

  assert.deepEqual(args, ["-p", "--output-format", "json", "--model", "claude-sonnet"]);
});

function recordingTransport(calls: LlmCompleteOptions[]): LlmTransport {
  return {
    async complete(_prompt, options) {
      calls.push(options);
      return { text: "{}", elapsedMs: 1 };
    },
    async close() {},
  };
}

for (const [name, create] of [
  ["ResponsesCliAdapter", (transport: LlmTransport) => new ResponsesCliAdapter(transport)],
  ["AppServerCliAdapter", (transport: LlmTransport) => new AppServerCliAdapter(transport)],
] as const) {
  test(`${name}는 structured output schema를 전송하고, 없을 때 request 계약을 바꾸지 않는다`, async () => {
    const calls: LlmCompleteOptions[] = [];
    const adapter = create(recordingTransport(calls));
    const outputSchema = { type: "object", properties: { answer: { type: "string" } } };

    await adapter.complete("schema", { model: "model", effort: "low", outputSchema });
    await adapter.complete("plain", { model: "model" });

    assert.deepEqual(calls[0], { model: "model", effort: "low", timeoutMs: undefined, outputSchema });
    assert.deepEqual(calls[1], { model: "model", effort: undefined, timeoutMs: undefined, outputSchema: undefined });
  });
}
