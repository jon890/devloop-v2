import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesCliAdapter } from "./llm";
import { llmAdapter } from "./main";

test("직접 전송을 고르면 app-server를 띄우지 않고 Responses 어댑터를 만든다", async () => {
  const adapter = await llmAdapter({
    provider: "codex",
    transport: "responses",
    model: "gpt-5.5",
    reasoningEffort: undefined,
    concurrency: 4,
    timeoutMs: 120_000,
  });

  assert.ok(adapter instanceof ResponsesCliAdapter);
  await adapter.close?.();
});
