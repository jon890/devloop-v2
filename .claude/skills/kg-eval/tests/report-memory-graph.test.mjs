import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMemoryGraphReport, canonicalBytes, renderMarkdown, sha256, verdict } from "../scripts/report-memory-graph.mjs";

function attempt(taskId, condition, repetition, overrides = {}) {
  return {
    taskId,
    condition,
    repetition,
    validationStatus: 0,
    taskSuccess: true,
    wrongEditCount: 0,
    wallTimeMs: 1000,
    turns: 1,
    toolCalls: 2,
    sourceReads: 0,
    memoryCalls: condition === "no-memory" ? 0 : 1,
    graphCalls: condition === "memory-graph" ? 3 : 0,
    graphLatencyMs: condition === "memory-graph" ? 10 : null,
    graphLlmCalls: 0,
    agentGraphCalls: 0,
    graphEvidenceUsed: condition === "memory-graph" ? null : undefined,
    ...overrides,
  };
}

function runShape() {
  const taskInputs = ["MEM-EXP-001", "MEM-EXP-002"].map((taskId) => ({
    taskId,
    baseRevision: `${taskId}-base`,
    validationCommand: ["node", "--version"],
  }));
  const baseline = {
    suiteHash: "suite-hash",
    sourceLockHash: "source-lock-hash",
    memoryIndexHash: `sha256:${"1".repeat(64)}`,
    agent: "codex",
    agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: "workspace-write" },
    taskInputs,
    attempts: [],
  };
  const graphRun = {
    suiteHash: baseline.suiteHash,
    sourceLockHash: baseline.sourceLockHash,
    memoryIndexHash: baseline.memoryIndexHash,
    graphLockHash: `sha256:${"2".repeat(64)}`,
    agent: baseline.agent,
    agentOptions: baseline.agentOptions,
    taskInputs,
    attempts: [],
  };
  for (const taskId of ["MEM-EXP-001", "MEM-EXP-002"]) {
    for (const condition of ["no-memory", "oracle-memory"]) {
      for (let repetition = 1; repetition <= 3; repetition += 1) baseline.attempts.push(attempt(taskId, condition, repetition));
    }
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      graphRun.attempts.push(attempt(taskId, "memory-graph", repetition, { graphEvidenceUsed: taskId === "MEM-EXP-001" && repetition === 2 ? true : null }));
    }
  }
  const graphLock = { graphStatsHash: `sha256:${"3".repeat(64)}` };
  const graphLockText = JSON.stringify(graphLock);
  graphRun.graphLockHash = sha256(graphLockText);
  return { baseline, graphRun, graphLock, graphLockFileHash: graphRun.graphLockHash };
}

test("reports no added value when oracle and memory-graph both succeed", () => {
  const report = buildMemoryGraphReport(runShape());
  assert.equal(report.overall.decision, "NO_ADDED_VALUE");
  assert.deepEqual(
    report.tasks.map((task) => [task.taskId, task.decision, task.evidence.trueCount, task.evidence.nullCount]),
    [
      ["MEM-EXP-001", "NO_ADDED_VALUE", 1, 2],
      ["MEM-EXP-002", "NO_ADDED_VALUE", 0, 3],
    ],
  );
  const json = canonicalBytes(report);
  const markdown = renderMarkdown(report);
  assert.equal(json.includes("resolvedElementId"), false);
  assert.equal(markdown.includes("source.example"), false);
  assert.match(markdown, /Overall decision: NO_ADDED_VALUE/);
});

test("added value requires full evidence and oracle recovery", () => {
  assert.equal(verdict({ oracleSummary: { taskSuccess: 2, attempts: 3 }, graphSummary: { taskSuccess: 3, attempts: 3 }, evidence: { trueCount: 3 } }), "ADDED_VALUE");
  assert.equal(verdict({ oracleSummary: { taskSuccess: 3, attempts: 3 }, graphSummary: { taskSuccess: 3, attempts: 3 }, evidence: { trueCount: 3 } }), "NO_ADDED_VALUE");
  assert.equal(verdict({ oracleSummary: { taskSuccess: 2, attempts: 3 }, graphSummary: { taskSuccess: 3, attempts: 3 }, evidence: { trueCount: 1 } }), "INCONCLUSIVE");
});

test("rejects a graph lock whose file hash differs from the measured run", () => {
  const inputs = runShape();
  inputs.graphLockFileHash = `sha256:${"f".repeat(64)}`;
  assert.throws(() => buildMemoryGraphReport(inputs), /graphLockHash differs/);
});

test("CLI output is deterministic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-graph-report-"));
  try {
    const { baseline, graphRun, graphLock } = runShape();
    const baselinePath = path.join(root, "baseline.json");
    const graphRunPath = path.join(root, "graph-run.json");
    const graphLockPath = path.join(root, "graph-lock.json");
    const jsonOut = path.join(root, "report.json");
    const markdownOut = path.join(root, "report.md");
    await writeFile(baselinePath, JSON.stringify(baseline), "utf8");
    await writeFile(graphRunPath, JSON.stringify(graphRun), "utf8");
    await writeFile(graphLockPath, JSON.stringify(graphLock), "utf8");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [
        ".claude/skills/kg-eval/scripts/report-memory-graph.mjs",
        "--baseline",
        baselinePath,
        "--graph-run",
        graphRunPath,
        "--graph-lock",
        graphLockPath,
        "--json-out",
        jsonOut,
        "--markdown-out",
        markdownOut,
      ],
      { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../.."), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(jsonOut, "utf8")).overall.decision, "NO_ADDED_VALUE");
    assert.match(await readFile(markdownOut, "utf8"), /MEM-EXP-001/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
