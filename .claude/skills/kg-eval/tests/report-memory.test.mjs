import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildMemoryReport, canonicalBytes, derivedFailureBoundary, stabilityForAttempts } from "../scripts/report-memory.mjs";
import { loadMemorySuite } from "../scripts/memory/suite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REPORT_CLI = path.join(REPO_ROOT, ".claude/skills/kg-eval/scripts/report-memory.mjs");
const FIXTURE_RUN = path.join(__dirname, "fixtures/memory/report/run-shape.jsonl");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function suite() {
  return {
    schemaVersion: "memory-eval-suite/v1",
    project: "tc-ocr",
    suiteId: "fixture-memory-report",
    title: "Fixture Memory Utility",
    sourceSnapshot: "public fixture",
    tasks: [
      { id: "MEM-CODE-001", category: "code-only", taskType: "localized-bugfix", sourceLockKey: "lock-1", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-CODE-002", category: "code-only", taskType: "test-repair", sourceLockKey: "lock-2", expectedTrigger: "code-context", tags: [] },
      {
        id: "MEM-EXP-001",
        category: "experience-needed",
        taskType: "regression-avoidance",
        sourceLockKey: "lock-3",
        expectedTrigger: "experience-memory",
        tags: ["relationship-heavy"],
      },
      { id: "MEM-EXP-002", category: "experience-needed", taskType: "cross-file-rework", sourceLockKey: "lock-4", expectedTrigger: "experience-memory", tags: [] },
    ],
  };
}

function attempt(taskId, condition, repetition, overrides = {}) {
  return {
    taskId,
    condition,
    repetition,
    status: 0,
    timedOut: false,
    validationStatus: overrides.taskSuccess === false ? 1 : 0,
    taskSuccess: true,
    wrongEditCount: 0,
    reworkCount: 0,
    sourceReads: 4 + repetition,
    memoryCalls: condition === "oracle-memory" ? 1 : 0,
    agentMemoryCalls: 0,
    oracleMemoryProvided: condition === "oracle-memory" ? 1 : 0,
    turns: 2 + repetition,
    toolCalls: 6 + repetition,
    wallTimeMs: 1000 + repetition * 100,
    inputTokens: repetition === 1 ? null : 1000 + repetition,
    outputTokens: null,
    failureBoundary: "NONE",
    triggerOutcome: condition === "agent-triggered" ? "expected_skip" : null,
    ...overrides,
  };
}

function observedRetrieval({ outcome = "hit", required = ["mem-required"], retrieved = ["mem-required", "mem-other"], query = "private query" } = {}) {
  return [
    {
      sourceRunKey: "fixture-run",
      query,
      topK: 10,
      requiredMemoryIds: required,
      retrievedMemoryIds: retrieved,
      outcome,
    },
  ];
}

function three(taskId, condition, overrides = {}) {
  return [1, 2, 3].map((repetition) => attempt(taskId, condition, repetition, typeof overrides === "function" ? overrides(repetition) : overrides));
}

async function fixtureRun() {
  const shape = JSON.parse((await readFile(FIXTURE_RUN, "utf8")).trim());
  const attempts = [
    ...three("MEM-CODE-001", "no-memory"),
    ...three("MEM-CODE-001", "agent-triggered"),
    ...three("MEM-CODE-001", "oracle-memory"),
    ...three("MEM-CODE-002", "no-memory"),
    ...three("MEM-CODE-002", "agent-triggered", (repetition) =>
      repetition === 1
        ? { taskSuccess: false, validationStatus: 0, wrongEditCount: 1, failureBoundary: "IMPLEMENTATION", agentMemoryCalls: 1, memoryCalls: 1, triggerOutcome: "unexpected_search" }
        : { taskSuccess: false, validationStatus: 1, failureBoundary: "VALIDATION" },
    ),
    ...three("MEM-CODE-002", "oracle-memory", { taskSuccess: false, validationStatus: 1, failureBoundary: "VALIDATION" }),
    ...three("MEM-EXP-001", "no-memory", { taskSuccess: false, validationStatus: 1, failureBoundary: "VALIDATION" }),
    ...three("MEM-EXP-001", "agent-triggered", {
      agentMemoryCalls: 1,
      memoryCalls: 1,
      sourceReads: 2,
      triggerOutcome: "expected_search",
      retrievalObservations: observedRetrieval(),
    }),
    ...three("MEM-EXP-001", "oracle-memory", { sourceReads: 1 }),
    ...three("MEM-EXP-002", "no-memory", (repetition) =>
      repetition === 3 ? { taskSuccess: false, validationStatus: 1, failureBoundary: "VALIDATION" } : {},
    ),
    ...three("MEM-EXP-002", "agent-triggered", (repetition) => {
      if (repetition === 1) {
        return {
          agentMemoryCalls: 1,
          memoryCalls: 1,
          triggerOutcome: "expected_search",
          retrievalObservations: observedRetrieval({ outcome: "miss", retrieved: ["mem-other"] }),
        };
      }
      if (repetition === 2) {
        return {
          agentMemoryCalls: 1,
          memoryCalls: 1,
          triggerOutcome: "expected_search",
          retrievalObservations: observedRetrieval({ outcome: "unobserved", required: [], retrieved: [] }),
        };
      }
      return { taskSuccess: false, validationStatus: 1, failureBoundary: "VALIDATION", triggerOutcome: "missed_search" };
    }),
    ...three("MEM-EXP-002", "oracle-memory"),
  ];
  return { ...shape, attempts };
}

test("stability requires 3/3 clean results and wrong edit takes regression precedence", () => {
  assert.equal(stabilityForAttempts(three("T", "no-memory")).status, "STABLE_SUCCESS");
  assert.equal(stabilityForAttempts(three("T", "no-memory", { taskSuccess: false, validationStatus: 1, failureBoundary: "VALIDATION" })).status, "STABLE_FAILURE");
  assert.equal(stabilityForAttempts(three("T", "no-memory", (repetition) => (repetition === 1 ? { wrongEditCount: 1 } : {}))).status, "REGRESSION");
  assert.equal(stabilityForAttempts(three("T", "agent-triggered", { retrievalObservations: observedRetrieval({ outcome: "unobserved", required: [], retrieved: [] }) })).status, "UNSTABLE");
});

test("failure boundary precedence keeps Memory and Agent ahead of lexical miss", () => {
  const missed = attempt("T", "agent-triggered", 1, {
    taskSuccess: false,
    validationStatus: 1,
    agentMemoryCalls: 1,
    memoryCalls: 1,
    retrievalObservations: observedRetrieval({ outcome: "miss", retrieved: ["other"] }),
  });
  assert.equal(derivedFailureBoundary(missed), "RETRIEVAL");
  assert.equal(derivedFailureBoundary({ ...missed, workspaceContamination: true }), "MEMORY");
  assert.equal(derivedFailureBoundary({ ...missed, status: 1 }), "AGENT");
  assert.equal(derivedFailureBoundary({ ...missed, wrongEditCount: 1, validationStatus: 0 }), "RETRIEVAL");
});

test("rejects duplicate and unexpected attempts before report aggregation", async () => {
  const run = await fixtureRun();
  const reportSuite = suite();
  const duplicate = { ...run.attempts[0] };
  assert.throws(
    () => buildMemoryReport({ run: { ...run, attempts: [...run.attempts, duplicate] }, suite: reportSuite }),
    /PHASE_BLOCKED: utility 비교 입력 불완전: duplicate/,
  );

  const unexpected = { ...run.attempts[0], condition: "automatic-memory" };
  assert.throws(
    () => buildMemoryReport({ run: { ...run, attempts: [...run.attempts, unexpected] }, suite: reportSuite }),
    /PHASE_BLOCKED: utility 비교 입력 불완전: unexpected/,
  );
});

test("builds public-safe memory utility report and canonical private miss lock", async () => {
  const run = await fixtureRun();
  const reportSuite = suite();
  const report = buildMemoryReport({ run, suite: reportSuite });
  assert.equal(report.report.run.attemptCount, 36);
  assert.equal(report.report.lexicalMissCount, 1);
  assert.equal(report.report.retrievalObservationComplete, false);
  assert.equal(report.report.triggerMatrix.TP, 4);
  assert.equal(report.report.triggerMatrix.FN, 1);
  assert.equal(report.report.triggerMatrix.FP, 1);
  assert.equal(report.report.triggerMatrix.TN, 5);
  assert.equal(report.report.triggerMatrix.unobservedCount, 1);
  assert.equal(report.report.triggerMatrix.precision, 0.8);
  assert.equal(report.report.triggerMatrix.recall, 0.8);

  const expBenefit = report.report.memoryBenefit.taskLevelDeltas.find((item) => item.taskId === "MEM-EXP-001" && item.condition === "agent-triggered");
  assert.equal(expBenefit.taskSuccessDelta, 1);
  assert.equal(expBenefit.sourceReadsDelta, -4);
  assert.equal(expBenefit.memoryCallsDelta, 1);

  const unstableDelta = report.report.memoryBenefit.taskLevelDeltas.find((item) => item.taskId === "MEM-EXP-002" && item.condition === "oracle-memory");
  assert.equal(unstableDelta.noMemoryStableUnavailable, true);
  assert.equal(unstableDelta.taskSuccessDelta, null);

  const stableAgentTax = report.report.retrievalTax.stable.find((item) => item.condition === "agent-triggered");
  assert.equal(stableAgentTax.groupCount, 2);
  assert.equal(stableAgentTax.unstableCount, 6);
  assert.equal(stableAgentTax.memoryCallsMedian, 0.5);
  assert.equal(stableAgentTax.outputTokensMedian, null);
  const unstableAgentTax = report.report.retrievalTax.unstable.find((item) => item.condition === "agent-triggered");
  assert.equal(unstableAgentTax.groupCount, 2);
  assert.equal(unstableAgentTax.attemptCount, 6);
  assert.equal(unstableAgentTax.unstableCount, 6);

  const privateBytes = canonicalBytes(report.privateMissLock);
  assert.equal(report.report.privateMissLockHash, createHash("sha256").update(privateBytes, "utf8").digest("hex"));
  assert.match(report.report.privateMissLockHash, /^[0-9a-f]{64}$/);
  assert(privateBytes.includes("private query"));
  const publicBytes = canonicalBytes(report.report);
  assert(!publicBytes.includes("private query"));
  assert(!publicBytes.includes("mem-required"));
  assert(!publicBytes.includes("mem-other"));
});

test("CLI writes byte-stable JSON, Markdown, and private miss lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "report-memory-"));
  try {
    const suitePath = path.join(root, "suite.json");
    await writeJson(suitePath, suite());
    const loadedSuite = await loadMemorySuite(suitePath);
    const run = { ...(await fixtureRun()), suitePath, suiteHash: loadedSuite.hash };
    const runPath = path.join(root, "run.jsonl");
    await writeFile(runPath, `${JSON.stringify(run)}\n`);
    const jsonOut = path.join(root, "report.json");
    const markdownOut = path.join(root, "report.md");
    const lockOut = path.join(root, "miss-lock.json");
    const result = spawnSync(process.execPath, [REPORT_CLI, "--run", runPath, "--json-out", jsonOut, "--markdown-out", markdownOut, "--private-miss-lock-out", lockOut], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const resultAgain = spawnSync(process.execPath, [REPORT_CLI, "--run", runPath, "--json-out", `${jsonOut}.again`, "--markdown-out", `${markdownOut}.again`, "--private-miss-lock-out", `${lockOut}.again`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(resultAgain.status, 0, resultAgain.stderr);
    assert.equal(await readFile(jsonOut, "utf8"), await readFile(`${jsonOut}.again`, "utf8"));
    assert.equal(await readFile(markdownOut, "utf8"), await readFile(`${markdownOut}.again`, "utf8"));
    assert.equal(await readFile(lockOut, "utf8"), await readFile(`${lockOut}.again`, "utf8"));
    const markdown = await readFile(markdownOut, "utf8");
    assert.match(markdown, /Memory Utility Report/);
    assert.match(markdown, /## Stable Retrieval Tax/);
    assert.match(markdown, /## Unstable Retrieval Tax/);
    assert.match(markdown, /\| agent-triggered \| 2 \| 6 \| 6 \|/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
