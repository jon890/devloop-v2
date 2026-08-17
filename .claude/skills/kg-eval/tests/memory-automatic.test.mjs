import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EXPERIMENTAL_MEMORY_CONDITIONS, MEMORY_CONDITIONS } from "../scripts/memory/condition.mjs";
import {
  allowedPathScope,
  automaticMemorySearchArgv,
  automaticScopePath,
  buildAutomaticMemoryContext,
  memoryFreshness,
  repositoryDisplayNameFromSourceLock,
  repositoryDisplayNameFromUrl,
  repositoryNameFromUrl,
} from "../scripts/memory/automatic-condition.mjs";
import { memorySearchArgv, parseArgs, runMemoryEvaluation } from "../scripts/run-memory.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function makeSourceRepo(root) {
  const repoPath = path.join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  git(["init", "-q"], repoPath);
  git(["config", "user.email", "fixture@example.invalid"], repoPath);
  git(["config", "user.name", "Fixture"], repoPath);
  await mkdir(path.join(repoPath, "docs"), { recursive: true });
  await writeFile(path.join(repoPath, "docs", "service.txt"), "base\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "base"], repoPath);
  const baseRevision = git(["rev-parse", "HEAD"], repoPath);
  await writeFile(path.join(repoPath, "docs", "service.txt"), "target\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "target"], repoPath);
  const targetRevision = git(["rev-parse", "HEAD"], repoPath);
  return { repoPath, baseRevision, targetRevision };
}

async function makeMemoryIndex(root) {
  const generationId = `wiki-${"a".repeat(64)}`;
  const projectDirectory = path.join(root, "data", "memory", "tc-ocr");
  const generationDirectory = path.join(projectDirectory, "wiki-generations", generationId);
  await mkdir(generationDirectory, { recursive: true });
  await writeJson(path.join(projectDirectory, "current-wiki.json"), { schemaVersion: 1, generationId });
  await writeJson(path.join(generationDirectory, "index.json"), {
    schemaVersion: 1,
    project: "tc-ocr",
    wikiGenerationId: generationId,
    extractionGenerationId: `ext-${"b".repeat(64)}`,
    sourceGenerationId: `src-${"c".repeat(64)}`,
    sourceManifestHash: `sha256:${"d".repeat(64)}`,
    extractionManifestHash: `sha256:${"e".repeat(64)}`,
    complete: false,
    documents: [],
  });
  return path.join(root, "data");
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "memory-automatic-"));
  const sourceRepo = await makeSourceRepo(root);
  const dataDir = await makeMemoryIndex(root);
  const suitePath = path.join(root, "suite.json");
  const sourceLockPath = path.join(root, "source-lock.json");
  const suite = {
    schemaVersion: "memory-eval-suite/v1",
    project: "tc-ocr",
    suiteId: "tc-ocr-memory-foundation",
    title: "fixture",
    sourceSnapshot: "private",
    tasks: [
      { id: "MEM-CODE-001", category: "code-only", taskType: "localized", sourceLockKey: "lock-code-1", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-CODE-002", category: "code-only", taskType: "localized", sourceLockKey: "lock-code-2", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-EXP-001", category: "experience-needed", taskType: "policy", sourceLockKey: "lock-exp-1", expectedTrigger: "experience-memory", tags: ["relationship-heavy"] },
      { id: "MEM-EXP-002", category: "experience-needed", taskType: "policy", sourceLockKey: "lock-exp-2", expectedTrigger: "experience-memory", tags: [] },
    ],
  };
  const sourceTasks = suite.tasks.map((publicTask) => task(sourceRepo, { taskId: publicTask.id, sourceLockKey: publicTask.sourceLockKey }));
  const sourceTask = sourceTasks.find((item) => item.taskId === "MEM-EXP-001");
  await writeJson(suitePath, suite);
  await writeJson(sourceLockPath, { schemaVersion: "memory-source-lock/v1", suiteId: suite.suiteId, sourceSnapshot: "fixture", tasks: sourceTasks });
  return { root, dataDir, suitePath, sourceLockPath, sourceRepo, sourceTask };
}

function task(sourceRepo, overrides = {}) {
  return {
    taskId: "MEM-EXP-001",
    sourceLockKey: "lock-1",
    repositoryPath: sourceRepo.repoPath,
    sourceUrl: `https://git.example.internal/team/Repo.git/commit/${sourceRepo.targetRevision}`,
    baseRevision: sourceRepo.baseRevision,
    targetRevision: sourceRepo.targetRevision,
    prompt: "Update service",
    allowedPaths: ["docs/service.txt", "docs/readme.md"],
    validationCommand: ["node", "--version"],
    oracleQuery: "exact oracle query",
    ...overrides,
  };
}

function memoryItem(sourceRepo, overrides = {}) {
  return {
    id: "m-current",
    title: "Current decision",
    body: "Use current source behavior.",
    status: "active",
    confidence: "high",
    sourceRefs: [{ repository: "repo", revision: sourceRepo.targetRevision, sourceType: "git", sourceUrl: `https://git.example.internal/team/repo/commit/${sourceRepo.targetRevision}` }],
    ...overrides,
  };
}

test("baseline conditions stay unchanged and automatic is experimental", () => {
  assert.deepEqual(MEMORY_CONDITIONS, ["no-memory", "agent-triggered", "oracle-memory"]);
  assert.deepEqual(EXPERIMENTAL_MEMORY_CONDITIONS, ["memory-graph", "automatic"]);
});

test("automatic search uses the same command builder with oracle query, topK 10, repository, and path scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-automatic-argv-"));
  try {
    const sourceRepo = await makeSourceRepo(root);
    const sourceTask = task(sourceRepo);
    assert.equal(repositoryNameFromUrl(sourceTask.sourceUrl), "repo");
    assert.equal(repositoryDisplayNameFromSourceLock(sourceTask), "Repo");
    assert.equal(repositoryNameFromUrl(`https://git.example.internal/team/Encoded%20Repo.git/blob/${sourceRepo.targetRevision}/docs/service.txt`), "encoded repo");
    assert.equal(repositoryDisplayNameFromUrl(`https://git.example.internal/team/OCR.API.git/blob/${sourceRepo.targetRevision}/docs/service.txt`), "OCR.API");
    assert.equal(allowedPathScope(sourceTask), "docs");
    assert.equal(automaticScopePath(sourceTask), "docs");
    const automaticArgv = automaticMemorySearchArgv({ task: sourceTask, dataDir: "./data", devloopRoot: "/repo/root", memorySearchArgv });
    assert.deepEqual(
      automaticArgv,
      memorySearchArgv({
        query: sourceTask.oracleQuery,
        dataDir: "./data",
        devloopRoot: "/repo/root",
        repository: "Repo",
        scopePath: "docs",
        topK: 10,
      }),
    );
    const rootScopeTask = task(sourceRepo, {
      sourceUrl: `https://git.example.internal/team/OCR.API/commit/${sourceRepo.targetRevision}`,
      allowedPaths: ["IDCardReader.py", "utils/util.py"],
    });
    assert.equal(allowedPathScope(rootScopeTask), ".");
    assert.equal(automaticScopePath(rootScopeTask), undefined);
    assert.deepEqual(
      automaticMemorySearchArgv({ task: rootScopeTask, dataDir: "./data", devloopRoot: "/repo/root", memorySearchArgv }),
      memorySearchArgv({
        query: rootScopeTask.oracleQuery,
        dataDir: "./data",
        devloopRoot: "/repo/root",
        repository: "OCR.API",
        topK: 10,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic context injects only active high current body and keeps unsafe results as warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-automatic-context-"));
  try {
    const sourceRepo = await makeSourceRepo(root);
    const sourceTask = task(sourceRepo);
    const staleRevision = "f".repeat(40);
    const result = buildAutomaticMemoryContext({
      task: sourceTask,
      memory: {
        results: [
          memoryItem(sourceRepo),
          memoryItem(sourceRepo, { id: "m-medium", title: "Medium", body: "medium body must not appear", confidence: "medium" }),
          memoryItem(sourceRepo, { id: "m-low", title: "Low", body: "low body must not appear", confidence: "low" }),
          memoryItem(sourceRepo, { id: "m-uncertain", title: "Uncertain", body: "uncertain body must not appear", status: "uncertain" }),
          memoryItem(sourceRepo, { id: "m-stale", title: "Stale opposite", body: "stale hostile opposite conclusion", sourceRefs: [{ repository: "repo", revision: staleRevision }] }),
          { id: "m-dooray", title: "Dooray only", body: "dooray body must not appear", status: "active", confidence: "high", sourceRefs: [{ sourceType: "dooray-wiki", url: "https://dooray.example.invalid/wiki/1" }] },
        ],
      },
    });

    assert.equal(result.metrics.memoryCalls, 1);
    assert.equal(result.metrics.retrievedCount, 6);
    assert.equal(result.metrics.injectedCount, 1);
    assert.equal(result.metrics.warnedCount, 4);
    assert.equal(result.metrics.skippedStaleCount, 1);
    assert.equal(result.metrics.retrievedCount, result.metrics.injectedCount + result.metrics.warnedCount + result.metrics.skippedStaleCount);
    assert.equal(result.metrics.staleInjectionCount, 0);
    assert.equal(result.context.results[0].body, "Use current source behavior.");
    assert.equal(JSON.stringify(result.context).includes("medium body must not appear"), false);
    assert.equal(JSON.stringify(result.context).includes("low body must not appear"), false);
    assert.equal(JSON.stringify(result.context).includes("uncertain body must not appear"), false);
    assert.equal(JSON.stringify(result.context).includes("stale hostile opposite conclusion"), false);
    const doorayWarning = result.context.warnings.find((warning) => warning.title === "Dooray only");
    assert.deepEqual(doorayWarning.provenance, [{ sourceType: "dooray-wiki", url: "https://dooray.example.invalid/wiki/1" }]);
    const staleWarning = result.context.warnings.find((warning) => warning.title === "Stale opposite");
    assert.equal(staleWarning.reason, "revision-conflict");
    assert.match(result.context.instruction, /current source is authoritative/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("freshness fails closed for source URL markers and treats any same-repo revision conflict as stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-automatic-freshness-"));
  try {
    const sourceRepo = await makeSourceRepo(root);
    assert.throws(() => buildAutomaticMemoryContext({ task: task(sourceRepo, { sourceUrl: "https://git.example.internal/team/repo" }), memory: { results: [] } }), /sourceUrl/);
    const staleRevision = "f".repeat(40);
    assert.deepEqual(
      memoryFreshness({
        item: memoryItem(sourceRepo, { sourceRefs: [{ repository: "repo", revision: sourceRepo.targetRevision }, { repository: "repo", revision: staleRevision }] }),
        taskRepository: "repo",
        allowedRevisions: new Set([sourceRepo.baseRevision, sourceRepo.targetRevision]),
      }),
      { status: "stale", reason: "revision-conflict" },
    );
    assert.deepEqual(
      memoryFreshness({
        item: memoryItem(sourceRepo, {
          sourceRefs: [{ repository: "repo", revision: sourceRepo.targetRevision, sourceUrl: `https://git.example.internal/team/other-repo/commit/${sourceRepo.targetRevision}` }],
        }),
        taskRepository: "repo",
        allowedRevisions: new Set([sourceRepo.baseRevision, sourceRepo.targetRevision]),
      }),
      { status: "unknown", reason: "repository-conflict" },
    );
    const conflictResult = buildAutomaticMemoryContext({
      task: task(sourceRepo),
      memory: {
        results: [
          memoryItem(sourceRepo, {
            title: "Conflicting repository markers",
            sourceRefs: [{ repository: "repo", revision: sourceRepo.targetRevision, sourceUrl: `https://git.example.internal/team/other-repo/commit/${sourceRepo.targetRevision}` }],
          }),
        ],
      },
    });
    assert.equal(conflictResult.metrics.injectedCount, 0);
    assert.equal(conflictResult.metrics.warnedCount, 1);
    assert.equal(conflictResult.context.warnings[0].reason, "confirm-source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseArgs and programmatic automatic execution require codex luna low", async () => {
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "automatic", "--agent", "claude", "--model", "gpt-5.6-luna", "--effort", "low"]), /agent=codex/);
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "automatic", "--agent", "codex", "--model", "gpt-5.6-terra", "--effort", "low"]), /model=gpt-5.6-luna/);
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "automatic", "--agent", "codex", "--model", "gpt-5.6-luna", "--effort", "medium"]), /effort=low/);
  const parsed = parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "automatic", "--agent", "codex", "--model", "gpt-5.6-luna", "--effort", "low"]);
  assert.deepEqual(parsed.conditions, ["automatic"]);

  const fixture = await makeFixture();
  try {
    const base = {
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath: path.join(fixture.root, "guard.json"),
      taskIds: ["MEM-EXP-001"],
      conditions: ["automatic"],
      repeats: 1,
      dryRun: true,
    };
    await assert.rejects(() => runMemoryEvaluation({ ...base, agent: "claude", agentOptions: { model: "gpt-5.6-luna", effort: "low" } }), /agent=codex/);
    await assert.rejects(() => runMemoryEvaluation({ ...base, agent: "codex", agentOptions: { model: "gpt-5.6-terra", effort: "low" } }), /model=gpt-5.6-luna/);
    await assert.rejects(() => runMemoryEvaluation({ ...base, agent: "codex", agentOptions: { model: "gpt-5.6-luna", effort: "medium" } }), /effort=low/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("automatic run calls memory search once before Agent and records flat retrieval metrics", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "automatic-run.json");
    const calls = [];
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-EXP-001"],
      conditions: ["automatic"],
      repeats: 1,
      timeoutMs: 1000,
      runMemorySearchFn: async (args) => {
        calls.push(args);
        return { ok: true, result: { status: 0 }, memory: { results: [memoryItem(fixture.sourceRepo)] } };
      },
      runAgentFn: async ({ cwd, prompt }) => {
        assert.match(prompt, /Automatic Memory context:/);
        assert.match(prompt, /current source is authoritative/);
        assert.doesNotMatch(prompt, /Use this exact command if Experience Memory search is warranted/);
        await writeFile(path.join(cwd, "docs", "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed" }), stderr: "" };
      },
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    const attempt = stored.attempts[0];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].query, fixture.sourceTask.oracleQuery);
    assert.equal(calls[0].topK, 10);
    assert.equal(calls[0].repository, "Repo");
    assert.equal(calls[0].scopePath, "docs");
    assert.equal(attempt.condition, "automatic");
    assert.equal(attempt.memoryCalls, 1);
    assert.equal(attempt.agentMemoryCalls, 0);
    assert.equal(attempt.retrievedCount, 1);
    assert.equal(attempt.injectedCount, 1);
    assert.equal(attempt.warnedCount, 0);
    assert.equal(attempt.skippedStaleCount, 0);
    assert.equal(attempt.staleInjectionCount, 0);
    assert.equal(attempt.triggerOutcome, "automatic_injected");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
