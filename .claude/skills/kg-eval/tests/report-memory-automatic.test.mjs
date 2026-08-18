import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAutomaticReport, canonicalBytes, decide } from "../scripts/report-memory-automatic.mjs";
import { loadSourceLock } from "../scripts/memory/source-lock.mjs";
import { loadMemorySuite } from "../scripts/memory/suite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REPORT_CLI = path.join(REPO_ROOT, ".claude/skills/kg-eval/scripts/report-memory-automatic.mjs");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function suite() {
  return {
    schemaVersion: "memory-eval-suite/v1",
    project: "tc-ocr",
    suiteId: "fixture-memory-automatic",
    title: "Fixture Memory Automatic",
    sourceSnapshot: "private fixture",
    tasks: [
      { id: "MEM-CODE-001", category: "code-only", taskType: "localized-bugfix", sourceLockKey: "lock-1", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-CODE-002", category: "code-only", taskType: "test-repair", sourceLockKey: "lock-2", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-EXP-001", category: "experience-needed", taskType: "regression-avoidance", sourceLockKey: "lock-3", expectedTrigger: "experience-memory", tags: ["relationship-heavy"] },
      { id: "MEM-EXP-002", category: "experience-needed", taskType: "cross-file-rework", sourceLockKey: "lock-4", expectedTrigger: "experience-memory", tags: [] },
    ],
  };
}

function taskInputs() {
  return suite().tasks.map((task, index) => ({
    taskId: task.id,
    baseRevision: `${index + 1}`.repeat(40),
    validationCommand: ["node", "-e", `assert-${task.id}`],
  }));
}

function sourceLock(root) {
  return {
    schemaVersion: "memory-source-lock/v1",
    suiteId: suite().suiteId,
    sourceSnapshot: "private fixture",
    tasks: suite().tasks.map((task, index) => ({
      taskId: task.id,
      sourceLockKey: task.sourceLockKey,
      repositoryPath: path.join(root, task.id),
      sourceUrl: `https://github.example.internal/team/${task.id}/commit/${`${index + 5}`.repeat(40)}`,
      baseRevision: `${index + 1}`.repeat(40),
      targetRevision: `${index + 5}`.repeat(40),
      prompt: `private prompt ${task.id}`,
      allowedPaths: ["src/index.js"],
      validationCommand: ["node", "-e", `assert-${task.id}`],
      oracleQuery: `private query ${task.id}`,
    })),
  };
}

function baseRun({ suitePath, suiteHash, sourceLockPath, sourceLockHash, condition, attempts }) {
  return {
    schemaVersion: "memory-run/v1",
    suitePath,
    suiteHash,
    sourceLockPath,
    sourceLockHash,
    memoryIndexHash: "memory-index-hash",
    taskInputs: taskInputs(),
    agent: "codex",
    agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: "workspace-write" },
    executionPlan: { conditions: [condition], repeats: 3 },
    attempts,
  };
}

function attempt(taskId, condition, repetition, overrides = {}) {
  const automatic = condition === "automatic";
  return {
    taskId,
    condition,
    repetition,
    status: 0,
    validationStatus: 0,
    taskSuccess: true,
    wrongEditCount: 0,
    memoryCalls: automatic ? 1 : 0,
    agentMemoryCalls: 0,
    sourceReads: 3,
    wallTimeMs: 1000 + repetition * 10,
    inputTokens: 1000 + repetition * 10,
    outputTokens: 100 + repetition,
    agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: "workspace-write" },
    triggerOutcome: automatic ? "automatic_warned_only" : "expected_skip",
    ...(automatic
      ? {
          retrievedCount: 1,
          injectedCount: 0,
          warnedCount: 1,
          skippedStaleCount: 0,
          contextBytes: 500,
          staleInjectionCount: 0,
        }
      : {}),
    ...overrides,
  };
}

function three(taskId, condition, overrides = {}) {
  return [1, 2, 3].map((repetition) => attempt(taskId, condition, repetition, typeof overrides === "function" ? overrides(repetition) : overrides));
}

async function fixtureRuns(root) {
  const suitePath = path.join(root, "suite.json");
  const sourceLockPath = path.join(root, "source-lock.json");
  await writeJson(suitePath, suite());
  await writeJson(sourceLockPath, sourceLock(root));
  const loadedSuite = await loadMemorySuite(suitePath);
  const loadedSourceLock = await loadSourceLock(sourceLockPath);
  const voluntaryAttempts = [
    ...three("MEM-CODE-001", "agent-triggered"),
    ...three("MEM-CODE-002", "agent-triggered"),
    ...three("MEM-EXP-001", "agent-triggered", (repetition) =>
      repetition === 1
        ? { taskSuccess: false, validationStatus: 0, wrongEditCount: 1, triggerOutcome: "missed_search", wallTimeMs: 1200, inputTokens: 1200, outputTokens: 120 }
        : { triggerOutcome: "missed_search", wallTimeMs: 1200, inputTokens: repetition === 2 ? null : 1200, outputTokens: 120 },
    ),
    ...three("MEM-EXP-002", "agent-triggered", { triggerOutcome: "missed_search" }),
  ];
  const automaticAttempts = [
    ...three("MEM-CODE-001", "automatic"),
    ...three("MEM-CODE-002", "automatic"),
    ...three("MEM-EXP-001", "automatic", { triggerOutcome: "automatic_injected", retrievedCount: 3, injectedCount: 2, warnedCount: 1, contextBytes: 1500, wallTimeMs: 1210, inputTokens: 1210, outputTokens: 121 }),
    ...three("MEM-EXP-002", "automatic"),
  ];
  return {
    voluntaryRun: baseRun({ suitePath, suiteHash: loadedSuite.hash, sourceLockPath, sourceLockHash: loadedSourceLock.hash, condition: "agent-triggered", attempts: voluntaryAttempts }),
    automaticRun: baseRun({ suitePath, suiteHash: loadedSuite.hash, sourceLockPath, sourceLockHash: loadedSourceLock.hash, condition: "automatic", attempts: automaticAttempts }),
  };
}

test("builds deterministic public automatic report with recovered task and unnecessary union", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "report-memory-automatic-"));
  try {
    const { voluntaryRun, automaticRun } = await fixtureRuns(root);
    const report = await buildAutomaticReport({
      voluntaryRun,
      automaticRun,
      voluntaryBytes: canonicalBytes(voluntaryRun),
      automaticBytes: canonicalBytes(automaticRun),
    });
    assert.equal(report.decision.decision, "INCONCLUSIVE");
    assert.deepEqual(report.costDecisionInput.missing, ["MEM-EXP-001.inputTokens"]);
    assert.equal(report.counts.recoveredTaskCount, 1);
    assert.deepEqual(report.recoveredTasks.map((task) => task.taskId), ["MEM-EXP-001"]);
    assert.equal(report.counts.unnecessaryCodeOnlyAttemptCount, 6);
    assert.equal(report.counts.emptyRetrievalAttemptCount, 0);
    assert.equal(report.counts.unnecessaryRetrievalAttemptCount, 6);
    assert.equal(report.trigger.voluntary.recall, 0);
    assert.equal(report.trigger.automatic.precision, 0.5);
    assert.equal(report.taskMetrics.find((task) => task.taskId === "MEM-EXP-001").metrics.inputTokens.voluntarySampleCount, 2);
    const publicBytes = canonicalBytes(report);
    assert(!publicBytes.includes("private query"));
    assert(!publicBytes.includes("originalRepositoryPath"));
    assert(!publicBytes.includes("transcript"));
    assert(!publicBytes.includes("rawContext"));
    assert(!/provenance/i.test(publicBytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decision priority rejects stale or wrong/regressed runs before recovery and cost", () => {
  const common = {
    recoveredTasks: [{}],
    unnecessary: { unionAttemptKeys: [] },
    voluntaryAttempts: [{ taskSuccess: true, wrongEditCount: 0 }],
    automaticAttempts: [{ taskSuccess: true, wrongEditCount: 0 }],
    taskRegressions: [],
    cost: { missing: [], overLimit: [] },
  };
  assert.equal(decide({ ...common, integrity: { staleInjectionCount: 1 } }).priority, 1);
  assert.equal(decide({ ...common, integrity: { staleInjectionCount: 0 }, automaticAttempts: [{ taskSuccess: true, wrongEditCount: 1 }] }).priority, 1);
  assert.equal(decide({ ...common, integrity: { staleInjectionCount: 0 }, taskRegressions: [{ taskId: "MEM-CODE-001" }] }).priority, 1);
  assert.equal(decide({ ...common, recoveredTasks: [], unnecessary: { unionAttemptKeys: ["MEM-CODE-001:1"] }, integrity: { staleInjectionCount: 0 } }).priority, 2);
  assert.equal(decide({ ...common, integrity: { staleInjectionCount: 0 }, cost: { missing: [], overLimit: ["MEM-EXP-001.inputTokens"] } }).priority, 4);
  assert.equal(decide({ ...common, integrity: { staleInjectionCount: 0 }, cost: { missing: ["MEM-EXP-001.inputTokens"], overLimit: [] } }).priority, 5);
});

test("rejects invalid automatic raw integrity before adoption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "report-memory-automatic-invalid-"));
  try {
    const { voluntaryRun, automaticRun } = await fixtureRuns(root);
    const memoryCallMismatch = {
      ...automaticRun,
      attempts: automaticRun.attempts.map((attempt, index) => (index === 0 ? { ...attempt, memoryCalls: 0 } : attempt)),
    };
    await assert.rejects(
      () =>
        buildAutomaticReport({
          voluntaryRun,
          automaticRun: memoryCallMismatch,
          voluntaryBytes: canonicalBytes(voluntaryRun),
          automaticBytes: canonicalBytes(memoryCallMismatch),
        }),
      /PHASE_BLOCKED: automatic raw 무결성 불일치/,
    );

    const bucketMismatch = {
      ...automaticRun,
      attempts: automaticRun.attempts.map((attempt, index) => (index === 0 ? { ...attempt, retrievedCount: 5 } : attempt)),
    };
    await assert.rejects(
      () =>
        buildAutomaticReport({
          voluntaryRun,
          automaticRun: bucketMismatch,
          voluntaryBytes: canonicalBytes(voluntaryRun),
          automaticBytes: canonicalBytes(bucketMismatch),
        }),
      /PHASE_BLOCKED: automatic raw 무결성 불일치/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects tampered run-level identity even when per-attempt identity is unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "report-memory-automatic-identity-"));
  try {
    const { voluntaryRun, automaticRun } = await fixtureRuns(root);
    const wrongTopLevelAgent = { ...automaticRun, agent: "claude" };
    await assert.rejects(
      () =>
        buildAutomaticReport({
          voluntaryRun,
          automaticRun: wrongTopLevelAgent,
          voluntaryBytes: canonicalBytes(voluntaryRun),
          automaticBytes: canonicalBytes(wrongTopLevelAgent),
        }),
      /PHASE_BLOCKED: automatic 비교 입력 불완전: run identity mismatch agent/,
    );

    const wrongTopLevelModel = { ...automaticRun, agentOptions: { ...automaticRun.agentOptions, model: "gpt-5.6-terra" } };
    await assert.rejects(
      () =>
        buildAutomaticReport({
          voluntaryRun,
          automaticRun: wrongTopLevelModel,
          voluntaryBytes: canonicalBytes(voluntaryRun),
          automaticBytes: canonicalBytes(wrongTopLevelModel),
        }),
      /PHASE_BLOCKED: automatic 비교 입력 불완전: run identity mismatch agentOptions.model/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects attempts simultaneously tampered away from expected identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "report-memory-automatic-attempt-identity-"));
  try {
    const { voluntaryRun, automaticRun } = await fixtureRuns(root);
    const tamperAttempts = (run) => ({
      ...run,
      attempts: run.attempts.map((attempt) => ({
        ...attempt,
        agentOptions: { ...attempt.agentOptions, model: "gpt-5.6-terra" },
      })),
    });
    const tamperedVoluntary = tamperAttempts(voluntaryRun);
    const tamperedAutomatic = tamperAttempts(automaticRun);
    await assert.rejects(
      () =>
        buildAutomaticReport({
          voluntaryRun: tamperedVoluntary,
          automaticRun: tamperedAutomatic,
          voluntaryBytes: canonicalBytes(tamperedVoluntary),
          automaticBytes: canonicalBytes(tamperedAutomatic),
        }),
      /identity mismatch MEM-CODE-001:1.model.expected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects matching bogus source lock hashes by recalculating source lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "report-memory-automatic-source-lock-"));
  try {
    const { voluntaryRun, automaticRun } = await fixtureRuns(root);
    const bogusVoluntary = { ...voluntaryRun, sourceLockHash: "0".repeat(64) };
    const bogusAutomatic = { ...automaticRun, sourceLockHash: "0".repeat(64) };
    await assert.rejects(
      () =>
        buildAutomaticReport({
          voluntaryRun: bogusVoluntary,
          automaticRun: bogusAutomatic,
          voluntaryBytes: canonicalBytes(bogusVoluntary),
          automaticBytes: canonicalBytes(bogusAutomatic),
        }),
      /source lock hash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI writes byte-stable JSON and Markdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "report-memory-automatic-cli-"));
  try {
    const { voluntaryRun, automaticRun } = await fixtureRuns(root);
    const voluntaryPath = path.join(root, "voluntary.json");
    const automaticPath = path.join(root, "automatic.json");
    const jsonOut = path.join(root, "report.json");
    const markdownOut = path.join(root, "report.md");
    await writeJson(voluntaryPath, voluntaryRun);
    await writeJson(automaticPath, automaticRun);
    const first = spawnSync(process.execPath, [REPORT_CLI, "--voluntary", voluntaryPath, "--automatic", automaticPath, "--json-out", jsonOut, "--markdown-out", markdownOut], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    const second = spawnSync(process.execPath, [REPORT_CLI, "--voluntary", voluntaryPath, "--automatic", automaticPath, "--json-out", `${jsonOut}.again`, "--markdown-out", `${markdownOut}.again`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(jsonOut, "utf8"), await readFile(`${jsonOut}.again`, "utf8"));
    assert.equal(await readFile(markdownOut, "utf8"), await readFile(`${markdownOut}.again`, "utf8"));
    assert.match(await readFile(markdownOut, "utf8"), /Plan017 Memory Automatic Report/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
