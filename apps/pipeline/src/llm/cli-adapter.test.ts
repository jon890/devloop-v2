import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeArgs } from "./claude-cli.adapter";
import { buildCodexArgs } from "./codex-cli.adapter";

test("Codex CLI 인자는 모델이 없으면 거부한다", () => {
  assert.throws(() => buildCodexArgs("/tmp/last-message.json", "prompt"), /CodexCliAdapter.*LLM_MODEL/);
});

test("Codex CLI 인자는 모델을 항상 붙이고 effort가 없으면 effort 플래그만 생략한다", () => {
  const args = buildCodexArgs("/tmp/last-message.json", "prompt", { model: "gpt-5.5" });

  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.5"]);
  assert.equal(
    args.some((value) => value.startsWith("model_reasoning_effort=")),
    false,
  );
  assert.deepEqual(args.slice(-1), ["prompt"]);
});

test("Codex CLI 인자는 모델과 effort가 있으면 명시 플래그를 붙인다", () => {
  const args = buildCodexArgs("/tmp/last-message.json", "prompt", { model: "gpt-5.5", effort: "high" });

  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.5"]);
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "model_reasoning_effort=high"]);
});

test("Claude CLI 인자는 모델이 없으면 거부한다", () => {
  assert.throws(() => buildClaudeArgs(), /ClaudeCliAdapter.*LLM_MODEL/);
});

test("Claude CLI 인자는 모델이 있으면 --model 을 붙인다", () => {
  const args = buildClaudeArgs({ model: "claude-sonnet" });

  assert.deepEqual(args, ["-p", "--output-format", "json", "--model", "claude-sonnet"]);
});
