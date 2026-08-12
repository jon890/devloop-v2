import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMemoryEvaluationInputs } from "../scripts/validate-memory-suite.mjs";
import { isSafeRunKey, materializeMemoryWorkspace } from "../scripts/memory/workspace.mjs";
import { acquireRunLock, loadOrCreateMemoryRun, releaseRunLock, withMemoryRun } from "../scripts/memory/result.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.resolve(__dirname, "../scripts/validate-memory-suite.mjs");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runConditions({ suitePath, sourceLockPath, sourceRepo }) {
  return {
    suitePath,
    sourceLockPath,
    suiteHash: "suite-hash",
    sourceLockHash: "source-lock-hash",
    taskInputs: [
      { taskId: "MEM-CODE-002", baseRevision: sourceRepo.targetRevision, validationCommand: ["node", "--version"] },
      { taskId: "MEM-CODE-001", baseRevision: sourceRepo.baseRevision, validationCommand: ["node", "--version"] },
    ],
    memoryIndexHash: "memory-index-hash",
    agent: "codex",
    agentOptions: { model: "gpt-5.6-luna", effort: "low" },
  };
}

async function makeSourceRepo(root) {
  const repoPath = path.join(root, "source-repo");
  await mkdir(repoPath, { recursive: true });
  git(["init", "-q"], repoPath);
  git(["config", "user.email", "fixture@example.invalid"], repoPath);
  git(["config", "user.name", "Fixture"], repoPath);
  await writeFile(path.join(repoPath, "service.txt"), "base\n");
  await mkdir(path.join(repoPath, "docs"), { recursive: true });
  await writeFile(path.join(repoPath, "docs", "note.txt"), "note\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "base"], repoPath);
  const baseRevision = git(["rev-parse", "HEAD"], repoPath);
  await writeFile(path.join(repoPath, "service.txt"), "target\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "target"], repoPath);
  const targetRevision = git(["rev-parse", "HEAD"], repoPath);
  return { repoPath, baseRevision, targetRevision };
}

function makePublicSuite() {
  return {
    schemaVersion: "memory-eval-suite/v1",
    project: "tc-ocr",
    suiteId: "tc-ocr-memory-foundation",
    title: "tc-ocr Memory 평가 foundation fixture",
    sourceSnapshot: "private source lock",
    tasks: [
      {
        id: "MEM-CODE-001",
        category: "code-only",
        taskType: "localized-bugfix",
        sourceLockKey: "lock-code-001",
        expectedTrigger: "code-context",
        tags: [],
      },
      {
        id: "MEM-CODE-002",
        category: "code-only",
        taskType: "test-repair",
        sourceLockKey: "lock-code-002",
        expectedTrigger: "code-context",
        tags: [],
      },
      {
        id: "MEM-EXP-001",
        category: "experience-needed",
        taskType: "regression-avoidance",
        sourceLockKey: "lock-exp-001",
        expectedTrigger: "experience-memory",
        tags: ["relationship-heavy"],
      },
      {
        id: "MEM-EXP-002",
        category: "experience-needed",
        taskType: "cross-file-rework",
        sourceLockKey: "lock-exp-002",
        expectedTrigger: "experience-memory",
        tags: [],
      },
    ],
  };
}

function makeSourceLock(sourceRepo) {
  return {
    schemaVersion: "memory-source-lock/v1",
    suiteId: "tc-ocr-memory-foundation",
    sourceSnapshot: "fixture-private-lock",
    tasks: makePublicSuite().tasks.map((task, index) => ({
      taskId: task.id,
      sourceLockKey: task.sourceLockKey,
      repositoryPath: sourceRepo.repoPath,
      sourceUrl: `https://dooray.example.internal/tasks/${index + 1}`,
      baseRevision: sourceRepo.baseRevision,
      targetRevision: sourceRepo.targetRevision,
      prompt: `Private prompt ${index + 1}`,
      allowedPaths: index === 1 ? ["service.txt", "docs/"] : ["service.txt"],
      validationCommand: ["node", "--version"],
      oracleQuery: `private oracle ${index + 1}`,
    })),
  };
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "memory-foundation-"));
  const sourceRepo = await makeSourceRepo(root);
  const suitePath = path.join(root, "suite.json");
  const sourceLockPath = path.join(root, "source-lock.json");
  await writeJson(suitePath, makePublicSuite());
  await writeJson(sourceLockPath, makeSourceLock(sourceRepo));
  return { root, sourceRepo, suitePath, sourceLockPath };
}

async function withFixture(callback) {
  const fixture = await makeFixture();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function repoState(repoPath) {
  return {
    branch: git(["branch", "--show-current"], repoPath),
    head: git(["rev-parse", "HEAD"], repoPath),
    status: git(["status", "--short"], repoPath),
  };
}

test("validates memory suite and prints private-safe one-line JSON", async () => {
  await withFixture(async ({ suitePath, sourceLockPath, sourceRepo }) => {
    const result = spawnSync(process.execPath, [VALIDATOR, "--suite", suitePath, "--source-lock", sourceLockPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, "memory-eval-suite/v1");
    assert.equal(output.taskCount, 4);
    assert.match(output.suiteHash, /^[0-9a-f]{64}$/);
    assert.match(output.sourceLockHash, /^[0-9a-f]{64}$/);
    assert(!result.stdout.includes(sourceRepo.repoPath));
    assert(!result.stdout.includes(sourceRepo.baseRevision));
    assert(!result.stdout.includes("Private prompt"));

    const loaded = await loadMemoryEvaluationInputs({ suitePath, sourceLockPath });
    assert.equal(loaded.taskCount, 4);
    assert.equal(loaded.suiteHash, output.suiteHash);
    assert.equal(loaded.sourceLockHash, output.sourceLockHash);
  });
});

test("rejects missing bijection and invalid private lock fields", async () => {
  await withFixture(async ({ sourceLockPath, suitePath }) => {
    const badLock = JSON.parse(await readFile(sourceLockPath, "utf8"));
    badLock.tasks[0].sourceLockKey = "lock-exp-002";
    badLock.tasks[1].baseRevision = "abc";
    badLock.tasks[2].repositoryPath = "relative/path";
    badLock.tasks[3].allowedPaths = ["../outside"];
    await writeJson(sourceLockPath, badLock);
    const result = spawnSync(process.execPath, [VALIDATOR, "--suite", suitePath, "--source-lock", sourceLockPath], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /baseRevision: must be a 40-character git revision/);
    assert.match(result.stderr, /repositoryPath: must be an absolute path/);
    assert.match(result.stderr, /allowedPaths\[0\]: must stay inside the repository/);
    assert.match(result.stderr, /does not map bijectively to task id/);
  });
});

test("rejects private fields in public memory suite", async () => {
  await withFixture(async ({ suitePath, sourceLockPath }) => {
    const privateFields = {
      repositoryPath: "/private/repo",
      sourceUrl: "https://dooray.example.internal/private",
      baseRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      prompt: "private prompt",
      oracleQuery: "private oracle",
      validationCommand: ["node", "--version"],
      allowedPaths: ["src/"],
    };
    const suite = makePublicSuite();
    Object.assign(suite, privateFields);
    Object.assign(suite.tasks[0], privateFields);
    await writeJson(suitePath, suite);
    const result = spawnSync(process.execPath, [VALIDATOR, "--suite", suitePath, "--source-lock", sourceLockPath], { encoding: "utf8" });
    assert.equal(result.status, 1);
    for (const field of Object.keys(privateFields)) {
      assert.match(result.stderr, new RegExp(`suite ${field}: unexpected field`));
      assert.match(result.stderr, new RegExp(`suite tasks\\[0\\]\\.${field}: unexpected field`));
    }
  });
});

test("materializes workspace with git archive without mutating source repository", async () => {
  await withFixture(async ({ root, sourceRepo, sourceLockPath }) => {
    const before = repoState(sourceRepo.repoPath);
    const sourceLock = JSON.parse(await readFile(sourceLockPath, "utf8"));
    const workspace = await materializeMemoryWorkspace({
      source: sourceLock.tasks[0],
      runKey: "run-001",
      runsRoot: path.join(root, "runs", "workspaces"),
    });
    assert.equal(await readFile(path.join(workspace.workspacePath, "service.txt"), "utf8"), "base\n");
    assert.match(workspace.baselineCommit, /^[0-9a-f]{40}$/);
    await stat(path.join(workspace.workspacePath, ".git"));
    assert.deepEqual(repoState(sourceRepo.repoPath), before);
  });
});

test("rejects unsafe run keys before workspace deletion", async () => {
  await withFixture(async ({ root, sourceLockPath }) => {
    const sourceLock = JSON.parse(await readFile(sourceLockPath, "utf8"));
    const runsRoot = path.join(root, "runs", "workspaces");
    const unsafeRunKeys = ["", "../x", "a/../x", "a/b", path.join(root, "absolute"), "nul\0key"];
    for (const runKey of unsafeRunKeys) {
      assert.equal(isSafeRunKey(runKey), false);
      await assert.rejects(
        () =>
          materializeMemoryWorkspace({
            source: sourceLock.tasks[0],
            runKey,
            runsRoot,
          }),
        /runKey must be a non-empty safe identifier/,
      );
    }
  });
});

test("stores memory results atomically and resumes only with matching conditions", async () => {
  await withFixture(async ({ root, sourceRepo, suitePath, sourceLockPath }) => {
    const outPath = path.join(root, "run.json");
    const conditions = runConditions({ suitePath, sourceLockPath, sourceRepo });
    await withMemoryRun(outPath, conditions, async ({ upsert }) => {
      await upsert({
        taskId: "MEM-CODE-001",
        condition: "without-memory",
        repetition: 1,
        taskSuccess: false,
        wrongEditCount: 1,
        reworkCount: 0,
      });
      await upsert({
        taskId: "MEM-CODE-001",
        condition: "without-memory",
        repetition: 1,
        taskSuccess: true,
        wrongEditCount: 0,
        reworkCount: 1,
      });
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(stored.attempts.length, 1);
    assert.equal(stored.attempts[0].taskSuccess, true);
    assert.equal(stored.agent, "codex");
    assert.deepEqual(stored.agentOptions, { model: "gpt-5.6-luna", effort: "low", permissionMode: null });

    const resumed = await loadOrCreateMemoryRun(outPath, conditions);
    assert.equal(resumed.attempts.length, 1);
    assert.deepEqual(
      resumed.taskInputs.map((input) => input.taskId),
      ["MEM-CODE-001", "MEM-CODE-002"],
    );
    await loadOrCreateMemoryRun(outPath, {
      ...conditions,
      taskInputs: [...conditions.taskInputs].reverse(),
    });
    await loadOrCreateMemoryRun(outPath, {
      ...conditions,
      agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: null },
    });
    await assert.rejects(
      () => loadOrCreateMemoryRun(outPath, { ...conditions, agent: "claude" }),
      /conditions differ: agent/,
    );
    await assert.rejects(
      () => loadOrCreateMemoryRun(outPath, { ...conditions, agentOptions: { ...conditions.agentOptions, model: "gpt-5.6-terra" } }),
      /conditions differ: agentOptions/,
    );
    await assert.rejects(
      () => loadOrCreateMemoryRun(outPath, { ...conditions, agentOptions: { ...conditions.agentOptions, effort: "medium" } }),
      /conditions differ: agentOptions/,
    );
    await assert.rejects(
      () => loadOrCreateMemoryRun(outPath, { ...conditions, agentOptions: { ...conditions.agentOptions, permissionMode: "workspace-write" } }),
      /conditions differ: agentOptions/,
    );
    await assert.rejects(
      () => loadOrCreateMemoryRun(outPath, { ...conditions, memoryIndexHash: "other-index" }),
      /conditions differ: memoryIndexHash/,
    );
    await assert.rejects(
      () =>
        loadOrCreateMemoryRun(outPath, {
          ...conditions,
          taskInputs: conditions.taskInputs.map((input) => (input.taskId === "MEM-CODE-001" ? { ...input, baseRevision: sourceRepo.targetRevision } : input)),
        }),
      /conditions differ: taskInputs/,
    );
    await assert.rejects(
      () =>
        loadOrCreateMemoryRun(outPath, {
          ...conditions,
          taskInputs: conditions.taskInputs.map((input) =>
            input.taskId === "MEM-CODE-002" ? { ...input, validationCommand: ["node", "--version", "--extra"] } : input,
          ),
        }),
      /conditions differ: taskInputs/,
    );

    const legacyPath = path.join(root, "legacy-run.json");
    const { agent, agentOptions, ...legacyConditions } = stored;
    await writeJson(legacyPath, legacyConditions);
    await assert.rejects(() => loadOrCreateMemoryRun(legacyPath, conditions), /conditions differ: agent/);

    const lock = await acquireRunLock(outPath);
    try {
      await assert.rejects(() => acquireRunLock(outPath), /output is locked/);
    } finally {
      await releaseRunLock(lock);
    }
  });
});

test("rejects invalid existing attempts and duplicate attempt keys", async () => {
  await withFixture(async ({ root, sourceRepo, suitePath, sourceLockPath }) => {
    const outPath = path.join(root, "invalid-run.json");
    const conditions = runConditions({ suitePath, sourceLockPath, sourceRepo });
    const baseRun = {
      schemaVersion: "memory-eval-run/v1",
      suitePath,
      sourceLockPath,
      suiteHash: conditions.suiteHash,
      sourceLockHash: conditions.sourceLockHash,
      taskInputs: conditions.taskInputs,
      memoryIndexHash: conditions.memoryIndexHash,
      agent: conditions.agent,
      agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: null },
      startedAt: new Date().toISOString(),
      attempts: [],
    };

    await writeJson(outPath, {
      ...baseRun,
      attempts: [{ taskId: "MEM-CODE-001", condition: "without-memory", repetition: 0 }],
    });
    await assert.rejects(() => loadOrCreateMemoryRun(outPath, conditions), /attempts\[0\]\.repetition: must be a positive integer/);

    await writeJson(outPath, {
      ...baseRun,
      attempts: [
        { taskId: "MEM-CODE-001", condition: "without-memory", repetition: 1 },
        { taskId: "MEM-CODE-001", condition: "without-memory", repetition: 1 },
      ],
    });
    await assert.rejects(() => loadOrCreateMemoryRun(outPath, conditions), /duplicate attempt key MEM-CODE-001:without-memory:1/);
  });
});
