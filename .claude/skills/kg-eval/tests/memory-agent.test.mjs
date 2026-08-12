import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentInvocation, assertEquivalentAgentOptions, runArgvProcess } from "../scripts/memory/agent-runner.mjs";
import { assertOnlyMemoryInformationDiffers, buildMemoryConditionInputs } from "../scripts/memory/condition.mjs";
import { normalizeAgentTelemetryJsonl } from "../scripts/memory/telemetry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures", "memory");

async function fixture(name) {
  return readFile(path.join(fixtures, name), "utf8");
}

function sigtermIgnoringDescendantScript({ ready, marker, trigger }) {
  const descendant = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{});",
    `fs.writeFileSync(${JSON.stringify(ready)},'ready');`,
    `setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),700);`,
    "setTimeout(()=>{},10000);",
  ].join("");
  return [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
    `while(!fs.existsSync(${JSON.stringify(ready)})) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }`,
    trigger === "overflow" ? "process.stdout.write('x'.repeat(1024));" : "",
    "setTimeout(()=>{},10000);",
  ].join("");
}

test("builds Codex and Claude invocations with argv arrays", () => {
  assert.deepEqual(buildAgentInvocation({ agent: "codex", prompt: "fix it", agentOptions: { model: "gpt-x", effort: "low", permissionMode: "workspace-write" } }), {
    command: "codex",
    args: ["exec", "--json", "--model", "gpt-x", "-c", 'model_reasoning_effort="low"', "--sandbox", "workspace-write", "fix it"],
  });
  assert.deepEqual(buildAgentInvocation({ agent: "claude", prompt: "fix it", agentOptions: { model: "claude-x", effort: "low", permissionMode: "dontAsk" } }), {
    command: "claude",
    args: ["-p", "--output-format", "stream-json", "--model", "claude-x", "--effort", "low", "--permission-mode", "dontAsk", "fix it"],
  });
});

test("renders only option names present in local CLI help", () => {
  const codexHelp = spawnSync("codex", ["exec", "--help"], { encoding: "utf8" });
  const claudeHelp = spawnSync("claude", ["--help"], { encoding: "utf8" });
  if (codexHelp.status === 0) {
    for (const option of ["--model", "-c", "--sandbox"]) assert.match(codexHelp.stdout, new RegExp(`(^|\\s)${option.replace("-", "\\-")}(,|\\s)`));
  }
  if (claudeHelp.status === 0) {
    for (const option of ["--model", "--effort", "--permission-mode"]) assert.match(claudeHelp.stdout, new RegExp(`(^|\\s)${option.replace("-", "\\-")}(,|\\s)`));
  }
});

test("rejects model, effort, and permission differences across conditions", () => {
  assertEquivalentAgentOptions([
    { condition: "no-memory", agentOptions: { model: "same", effort: "low", permissionMode: "workspace-write" } },
    { condition: "agent-triggered", agentOptions: { model: "same", effort: "low", permissionMode: "workspace-write" } },
  ]);
  for (const key of ["model", "effort", "permissionMode"]) {
    assert.throws(
      () =>
        assertEquivalentAgentOptions([
          { condition: "no-memory", agentOptions: { model: "same", effort: "low", permissionMode: "workspace-write" } },
          { condition: "agent-triggered", agentOptions: { model: "same", effort: "low", permissionMode: "workspace-write", [key]: "different" } },
        ]),
      new RegExp(key),
    );
  }
});

test("normalizes Codex command_execution and usage telemetry", async () => {
  assert.deepEqual(normalizeAgentTelemetryJsonl(await fixture("codex-command.jsonl")), {
    turns: 2,
    toolCalls: 4,
    sourceReads: 2,
    memoryCalls: 1,
    graphCalls: 1,
    inputTokens: 1220,
    outputTokens: 350,
    reworkCount: 0,
  });
});

test("normalizes Claude tool_use and result usage telemetry", async () => {
  assert.deepEqual(normalizeAgentTelemetryJsonl(await fixture("claude-command.jsonl")), {
    turns: 1,
    toolCalls: 3,
    sourceReads: 2,
    memoryCalls: 1,
    graphCalls: 0,
    inputTokens: 1000,
    outputTokens: 240,
    reworkCount: 0,
  });
});

test("keeps tokens null when usage is missing and only counts actual memory-search commands", async () => {
  assert.deepEqual(normalizeAgentTelemetryJsonl(await fixture("usage-missing.jsonl")), {
    turns: 1,
    toolCalls: 1,
    sourceReads: 0,
    memoryCalls: 0,
    graphCalls: 0,
    inputTokens: null,
    outputTokens: null,
    reworkCount: 0,
  });
});

test("builds three memory condition inputs with only Memory information different", () => {
  const inputs = buildMemoryConditionInputs({
    task: {
      taskId: "MEM-EXP-001",
      prompt: "Fix the migration regression.",
      baseRevision: "a".repeat(40),
      validationCommand: ["pnpm", "test"],
    },
    oracleMemory: [{ id: "mem-1", confidence: "high" }],
  });
  assert.deepEqual(
    inputs.map((input) => input.condition),
    ["no-memory", "agent-triggered", "oracle-memory"],
  );
  assertOnlyMemoryInformationDiffers(inputs);
  assert.equal(inputs[0].prompt, inputs[2].prompt);
  assert.equal(inputs[0].revision, inputs[2].revision);
  assert.deepEqual(inputs[0].validationCommand, inputs[2].validationCommand);
  assert.notDeepEqual(inputs[0].memoryInformation, inputs[2].memoryInformation);
});

test("enforces timeout without paid Agent execution", async () => {
  const result = await runArgvProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    timeoutMs: 50,
    killGraceMs: 10,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null);
});

test("kills descendant process group on timeout before descendants can write later", async () => {
  if (process.platform === "win32") return;
  const marker = path.join(tmpdir(), `memory-runner-timeout-${process.pid}-${Date.now()}`);
  const script = [
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),300)`) }],{stdio:'ignore'});`,
    "setTimeout(()=>{},10000);",
  ].join("");
  const result = await runArgvProcess({
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 50,
    killGraceMs: 50,
  });
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(() => access(marker));
  await rm(marker, { force: true });
});

test("delivers final SIGKILL before resolving timeout when descendant ignores SIGTERM", async () => {
  if (process.platform === "win32") return;
  const id = `memory-runner-ignore-timeout-${process.pid}-${Date.now()}`;
  const ready = path.join(tmpdir(), `${id}.ready`);
  const marker = path.join(tmpdir(), `${id}.marker`);
  const result = await runArgvProcess({
    command: process.execPath,
    args: ["-e", sigtermIgnoringDescendantScript({ ready, marker, trigger: "timeout" })],
    timeoutMs: 150,
    killGraceMs: 250,
  });
  assert.equal(result.timedOut, true);
  await access(ready);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(() => access(marker));
  await rm(ready, { force: true });
  await rm(marker, { force: true });
});

test("kills process tree on stdout overflow and waits for close", async () => {
  if (process.platform === "win32") return;
  const marker = path.join(tmpdir(), `memory-runner-overflow-${process.pid}-${Date.now()}`);
  const script = [
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),300)`) }],{stdio:'ignore'});`,
    "process.stdout.write('x'.repeat(1024));",
    "setTimeout(()=>{},10000);",
  ].join("");
  const result = await runArgvProcess({
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 5000,
    killGraceMs: 50,
    maxStdoutBytes: 8,
  });
  assert.equal(result.outputOverflow, "stdout");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(() => access(marker));
  await rm(marker, { force: true });
});

test("delivers final SIGKILL before resolving stdout overflow when descendant ignores SIGTERM", async () => {
  if (process.platform === "win32") return;
  const id = `memory-runner-ignore-overflow-${process.pid}-${Date.now()}`;
  const ready = path.join(tmpdir(), `${id}.ready`);
  const marker = path.join(tmpdir(), `${id}.marker`);
  const result = await runArgvProcess({
    command: process.execPath,
    args: ["-e", sigtermIgnoringDescendantScript({ ready, marker, trigger: "overflow" })],
    timeoutMs: 5000,
    killGraceMs: 250,
    maxStdoutBytes: 8,
  });
  assert.equal(result.outputOverflow, "stdout");
  await access(ready);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(() => access(marker));
  await rm(ready, { force: true });
  await rm(marker, { force: true });
});
