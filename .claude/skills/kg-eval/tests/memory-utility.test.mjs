import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertOnlyMemoryInformationDiffers, buildMemoryConditionInputs, MEMORY_CONDITIONS } from "../scripts/memory/condition.mjs";
import { materializeMemoryWorkspace } from "../scripts/memory/workspace.mjs";
import { loadMemoryEvaluationInputs } from "../scripts/validate-memory-suite.mjs";
import { buildAttemptSchedule, runMemoryEvaluation } from "../scripts/run-memory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PRIVATE_SUITE = path.join(REPO_ROOT, "eval/suites/tc-ocr-memory.json");
const PRIVATE_SOURCE_LOCK = path.join(REPO_ROOT, "eval/runs/plan014-memory-source-lock.json");
const PRIVATE_DATA_DIR = path.join(REPO_ROOT, "apps/pipeline/data");

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return result;
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function git(args, cwd) {
  const result = run("git", args, cwd);
  requireSuccess(result, `git ${args.join(" ")}`);
  return result.stdout.trim();
}

function validationResult(command, cwd) {
  assert(Array.isArray(command) && command.length > 0);
  return run(command[0], command.slice(1), cwd);
}

async function makeSourceRepo(root) {
  const repoPath = path.join(root, "source-repo");
  await mkdir(repoPath, { recursive: true });
  git(["init", "-q"], repoPath);
  git(["config", "user.email", "fixture@example.invalid"], repoPath);
  git(["config", "user.name", "Fixture"], repoPath);
  await writeFile(
    path.join(repoPath, "service.mjs"),
    "import assert from 'node:assert/strict';\nassert.equal('base', 'target');\n",
  );
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "base"], repoPath);
  const baseRevision = git(["rev-parse", "HEAD"], repoPath);
  await writeFile(
    path.join(repoPath, "service.mjs"),
    "import assert from 'node:assert/strict';\nassert.equal('target', 'target');\n",
  );
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "target"], repoPath);
  const targetRevision = git(["rev-parse", "HEAD"], repoPath);
  return { repoPath, baseRevision, targetRevision };
}

function sourceTask(sourceRepo, overrides = {}) {
  return {
    taskId: "MEM-FIXTURE-001",
    sourceLockKey: "fixture-lock",
    repositoryPath: sourceRepo.repoPath,
    sourceUrl: `https://source.example.invalid/${sourceRepo.targetRevision}`,
    baseRevision: sourceRepo.baseRevision,
    targetRevision: sourceRepo.targetRevision,
    prompt: "Repair the assertion.",
    allowedPaths: ["service.mjs"],
    validationCommand: [process.execPath, "service.mjs"],
    oracleQuery: "assertion repair",
    ...overrides,
  };
}

async function applyTargetPatch(task, workspacePath) {
  const diff = run("git", ["-C", task.repositoryPath, "diff", "--binary", task.baseRevision, task.targetRevision], REPO_ROOT);
  requireSuccess(diff, "target diff");
  const apply = spawnSync("git", ["apply", "--binary", "-"], {
    cwd: workspacePath,
    input: diff.stdout,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  requireSuccess(apply, "target patch apply");
}

async function assertBaseFailsTargetPasses({ task, runsRoot }) {
  const runKey = `${task.taskId}-validation-proof`.replace(/[^A-Za-z0-9_.-]/g, "-");
  const { workspacePath } = await materializeMemoryWorkspace({ source: task, runKey, runsRoot });
  const base = validationResult(task.validationCommand, workspacePath);
  assert.notEqual(base.status, 0, `${task.taskId} validation unexpectedly passed at base`);
  await applyTargetPatch(task, workspacePath);
  const target = validationResult(task.validationCommand, workspacePath);
  assert.equal(target.status, 0, `${task.taskId} validation failed at target\nstdout:\n${target.stdout}\nstderr:\n${target.stderr}`);
}

test("memory condition inputs keep task identity byte-identical except Memory policy and context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-utility-condition-"));
  try {
    const repo = await makeSourceRepo(root);
    const task = sourceTask(repo);
    const inputs = buildMemoryConditionInputs({ task, oracleMemory: { results: [{ id: "memory-1" }] } });
    assert.deepEqual(
      inputs.map((input) => input.condition),
      MEMORY_CONDITIONS,
    );
    assert.equal(assertOnlyMemoryInformationDiffers(inputs), true);

    const comparable = inputs.map((input) =>
      Buffer.from(
        JSON.stringify({
          prompt: input.prompt,
          baseRevision: input.baseRevision,
          allowedPaths: input.allowedPaths,
          validationCommand: input.validationCommand,
        }),
      ),
    );
    assert(comparable[0].equals(comparable[1]));
    assert(comparable[0].equals(comparable[2]));

    const broken = buildMemoryConditionInputs({ task, oracleMemory: null });
    broken[2].allowedPaths = ["other.mjs"];
    assert.throws(() => assertOnlyMemoryInformationDiffers(broken), /allowed paths/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation proof fails at base and passes at target without Agent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-utility-validation-"));
  try {
    const repo = await makeSourceRepo(root);
    await assertBaseFailsTargetPasses({
      task: sourceTask(repo),
      runsRoot: path.join(root, "workspaces"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan014 private source lock has identical condition inputs and independent base-target validation proofs", { skip: !(await exists(PRIVATE_SOURCE_LOCK)) }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plan014-memory-utility-"));
  try {
    const { sourceLock } = await loadMemoryEvaluationInputs({ suitePath: PRIVATE_SUITE, sourceLockPath: PRIVATE_SOURCE_LOCK });
    assert.equal(sourceLock.tasks.length, 4);
    for (const task of sourceLock.tasks) {
      const inputs = buildMemoryConditionInputs({ task, oracleMemory: { results: [{ sourceRefs: [{ url: "https://source.example.invalid/ref" }] }] } });
      assert.equal(assertOnlyMemoryInformationDiffers(inputs), true);
      await assertBaseFailsTargetPasses({ task, runsRoot: path.join(root, "workspaces") });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan014 dry-run plans four tasks across three conditions and three repetitions without Agent", { skip: !(await exists(PRIVATE_SOURCE_LOCK)) }, async () => {
  const result = await runMemoryEvaluation({
    suitePath: PRIVATE_SUITE,
    sourceLockPath: PRIVATE_SOURCE_LOCK,
    dataDir: PRIVATE_DATA_DIR,
    outPath: path.join(tmpdir(), "unused-plan014-dry-run.json"),
    conditions: ["no-memory", "agent-triggered", "oracle-memory"],
    repeats: 3,
    dryRun: true,
  });
  assert.equal(result.taskCount, 4);
  assert.equal(result.plannedAttempts, 36);
  assert.equal(result.dryRun, true);
  assert.match(result.suiteHash, /^[0-9a-f]{64}$/);
  assert.match(result.sourceLockHash, /^[0-9a-f]{64}$/);
  assert.match(result.memoryIndexHash, /^sha256:[0-9a-f]{64}$/);
});

test("Plan014 utility schedule keeps default compatibility and supports interleaving", { skip: !(await exists(PRIVATE_SOURCE_LOCK)) }, async () => {
  const { sourceLock } = await loadMemoryEvaluationInputs({ suitePath: PRIVATE_SUITE, sourceLockPath: PRIVATE_SOURCE_LOCK });
  const tasks = sourceLock.tasks.slice(0, 1).map((sourceTask) => ({ sourceTask }));
  const conditions = ["no-memory", "agent-triggered", "oracle-memory"];
  assert.deepEqual(
    buildAttemptSchedule({ tasks, conditions, repeats: 2, schedule: "default" }).map(({ condition, repetition }) => [condition, repetition]),
    [
      ["no-memory", 1],
      ["no-memory", 2],
      ["agent-triggered", 1],
      ["agent-triggered", 2],
      ["oracle-memory", 1],
      ["oracle-memory", 2],
    ],
  );
  assert.deepEqual(
    buildAttemptSchedule({ tasks, conditions, repeats: 2, schedule: "interleaved" }).map(({ condition, repetition }) => [condition, repetition]),
    [
      ["no-memory", 1],
      ["agent-triggered", 1],
      ["oracle-memory", 1],
      ["no-memory", 2],
      ["agent-triggered", 2],
      ["oracle-memory", 2],
    ],
  );
});
