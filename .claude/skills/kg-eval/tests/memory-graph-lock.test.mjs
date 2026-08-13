import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalHash } from "../scripts/memory/suite.mjs";
import { buildGraphLock, findSampleNode } from "../scripts/memory/graph-lock.mjs";
import { resolveSourceRepositoryRoot } from "../scripts/memory/source-repository-root.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function makeSourceRepo(root, basename, targetMessage) {
  const repoPath = path.join(root, basename);
  await mkdir(repoPath, { recursive: true });
  git(["init", "-q"], repoPath);
  git(["config", "user.email", "fixture@example.invalid"], repoPath);
  git(["config", "user.name", "Fixture"], repoPath);
  await writeFile(path.join(repoPath, "service.txt"), "base\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "base"], repoPath);
  const baseRevision = git(["rev-parse", "HEAD"], repoPath);
  await writeFile(path.join(repoPath, "service.txt"), "target\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", targetMessage], repoPath);
  const targetRevision = git(["rev-parse", "HEAD"], repoPath);
  return { repoPath, baseRevision, targetRevision };
}

function task({ id, key, sourceLockKey, repo, originalRoot, sourceUrlHost = "github.example.internal" }) {
  return {
    taskId: id,
    sourceLockKey,
    repositoryPath: path.join("/deleted/plan014/worktree", path.basename(repo.repoPath)),
    originalRepositoryPath: path.join(originalRoot, path.basename(repo.repoPath)),
    sourceUrl: `https://${sourceUrlHost}/team/${path.basename(repo.repoPath)}/commit/${repo.targetRevision}`,
    baseRevision: repo.baseRevision,
    targetRevision: repo.targetRevision,
    prompt: `Update ${id}`,
    allowedPaths: ["service.txt"],
    validationCommand: ["node", "--version"],
    oracleQuery: `${key} oracle evidence`,
  };
}

async function makeFixture(root) {
  const sourceRoot = path.join(root, "OCR");
  const originalRoot = path.join(root, "original-OCR");
  const api = await makeSourceRepo(sourceRoot, "OCR.API", "target\n\nLB listener evidence");
  const admin = await makeSourceRepo(sourceRoot, "OCR.Admin", "CAB API v7 response shape");
  const suite = {
    schemaVersion: "memory-eval-suite/v1",
    project: "tc-ocr",
    suiteId: "tc-ocr-memory-foundation",
    title: "fixture",
    sourceSnapshot: "private source lock",
    tasks: [
      { id: "MEM-CODE-001", category: "code-only", taskType: "localized", sourceLockKey: "lock-1", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-CODE-002", category: "code-only", taskType: "localized", sourceLockKey: "lock-2", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-EXP-001", category: "experience-needed", taskType: "regression-avoidance", sourceLockKey: "lock-3", expectedTrigger: "experience-memory", tags: ["relationship-heavy"] },
      { id: "MEM-EXP-002", category: "experience-needed", taskType: "cross-file-rework", sourceLockKey: "lock-4", expectedTrigger: "experience-memory", tags: [] },
    ],
  };
  const sourceLock = {
    schemaVersion: "memory-source-lock/v1",
    suiteId: suite.suiteId,
    sourceSnapshot: "fixture",
    tasks: [
      task({ id: "MEM-CODE-001", key: "code", sourceLockKey: "lock-1", repo: api, originalRoot }),
      task({ id: "MEM-CODE-002", key: "code", sourceLockKey: "lock-2", repo: admin, originalRoot }),
      task({ id: "MEM-EXP-001", key: "LB", sourceLockKey: "lock-3", repo: api, originalRoot }),
      task({ id: "MEM-EXP-002", key: "cab api", sourceLockKey: "lock-4", repo: admin, originalRoot }),
    ],
  };
  const plan014Run = {
    schemaVersion: "memory-eval-run/v1",
    suiteHash: canonicalHash(suite),
    sourceLockHash: canonicalHash(sourceLock),
    memoryIndexHash: `sha256:${"1".repeat(64)}`,
    executionPlan: { conditions: ["no-memory", "agent-triggered", "oracle-memory"], repeats: 3 },
    agent: "codex",
    agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: "workspace-write" },
    attempts: [],
  };
  for (const taskId of ["MEM-EXP-001", "MEM-EXP-002"]) {
    for (const condition of ["no-memory", "oracle-memory"]) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        plan014Run.attempts.push({
          taskId,
          condition,
          repetition,
          validationStatus: 0,
          taskSuccess: true,
          workspaceDiffHash: `${taskId}-${condition}-${repetition}`,
        });
      }
    }
  }
  const suitePath = path.join(root, "suite.json");
  const sourceLockPath = path.join(root, "source-lock.json");
  const plan014RunPath = path.join(root, "plan014-run.json");
  await writeJson(suitePath, suite);
  await writeJson(sourceLockPath, sourceLock);
  await writeJson(plan014RunPath, plan014Run);
  return { sourceRoot, suitePath, sourceLockPath, plan014RunPath, sourceLock, plan014Run };
}

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function fetchFixture(url) {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/graph/stats") return response({ nodes: { Concept: 2 }, relationships: { MENTIONS: 2 } });
  if (parsed.pathname === "/api/graph/search") {
    const q = parsed.searchParams.get("q");
    return response([{ id: q === "LB" ? "node-lb" : "node-cab", label: "Concept", key: q, display: q, properties: { secret: "drop" } }]);
  }
  if (parsed.pathname === "/api/graph/samples") {
    const offset = Number(parsed.searchParams.get("offset") ?? 0);
    const nodes =
      offset === 0
        ? [{ id: "node-lb", label: "Concept", key: "LB", display: "LB", properties: { secret: "drop" } }]
        : [{ id: "node-cab", label: "Concept", key: "cab api", display: "cab api", properties: { secret: "drop" } }];
    return response({ nodes, relationships: [], total: 101, offset, limit: 100 });
  }
  if (parsed.pathname.endsWith("/neighbors")) {
    const nodeId = decodeURIComponent(parsed.pathname.split("/").at(-2));
    return response({
      nodes: [{ id: nodeId, label: "Concept", key: nodeId === "node-lb" ? "LB" : "cab api", display: "anchor", properties: { secret: "drop" } }],
      relationships: [{ id: `rel-${nodeId}`, type: "MENTIONS", startId: "task-1", endId: nodeId, properties: { secret: "drop" } }],
    });
  }
  return response({ error: "not found" }, false, 404);
}

test("resolves source repositories by original basename and verifies commits fail-close", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "source-root-"));
  try {
    const { sourceRoot, sourceLock } = await makeFixture(root);
    const selected = sourceLock.tasks.filter((item) => item.taskId.startsWith("MEM-EXP"));
    const resolved = await resolveSourceRepositoryRoot({ sourceRepositoryRoot: sourceRoot, tasks: selected });
    assert.equal(resolved.tasks[0].repositoryPath, await realpath(path.join(sourceRoot, "OCR.API")));
    assert.equal(resolved.resolvedRepositories.length, 2);
    await assert.rejects(
      () => resolveSourceRepositoryRoot({ sourceRepositoryRoot: path.join(root, "missing"), tasks: selected }),
      /ENOENT/,
    );
    await assert.rejects(
      () => resolveSourceRepositoryRoot({ sourceRepositoryRoot: sourceRoot, tasks: [{ ...selected[0], targetRevision: "0".repeat(40) }] }),
      /targetRevision not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds exact sample node through pagination", async () => {
  const result = await findSampleNode({ fetchFn: fetchFixture, apiBaseUrl: "http://graph.test", label: "Concept", key: "cab api" });
  assert.equal(result.node.id, "node-cab");
  assert.equal(result.samplePage.offset, 100);
});

test("builds private graph lock without raw graph properties", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "graph-lock-"));
  try {
    const fixture = await makeFixture(root);
    const lock = await buildGraphLock({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      plan014RunPath: fixture.plan014RunPath,
      sourceRepositoryRoot: fixture.sourceRoot,
      apiBaseUrl: "http://graph.test",
      expectedMemoryIndexHash: fixture.plan014Run.memoryIndexHash,
      fetchFn: fetchFixture,
    });
    assert.equal(lock.schemaVersion, "memory-graph-lock/v1");
    assert.equal(lock.tasks.length, 2);
    assert.equal(lock.tasks.flatMap((task) => task.plan014RunKeys).length, 12);
    assert.deepEqual(lock.tasks.map((task) => task.resolvedElementId), ["node-lb", "node-cab"]);
    assert.equal(JSON.stringify(lock).includes("secret"), false);
    assert.match(lock.graphStatsHash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph lock rejects plan014 suite hash mismatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "graph-lock-suite-mismatch-"));
  try {
    const fixture = await makeFixture(root);
    const badRunPath = path.join(root, "bad-plan014-run.json");
    await writeJson(badRunPath, { ...fixture.plan014Run, suiteHash: "different-suite-hash" });
    await assert.rejects(
      () =>
        buildGraphLock({
          suitePath: fixture.suitePath,
          sourceLockPath: fixture.sourceLockPath,
          plan014RunPath: badRunPath,
          sourceRepositoryRoot: fixture.sourceRoot,
          apiBaseUrl: "http://graph.test",
          expectedMemoryIndexHash: fixture.plan014Run.memoryIndexHash,
          fetchFn: fetchFixture,
        }),
      /suiteHash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph lock rejects failed selected plan014 validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "graph-lock-validation-failure-"));
  try {
    const fixture = await makeFixture(root);
    const badRunPath = path.join(root, "bad-plan014-run.json");
    const badRun = structuredClone(fixture.plan014Run);
    badRun.attempts.find((attempt) => attempt.taskId === "MEM-EXP-001" && attempt.condition === "oracle-memory" && attempt.repetition === 2).validationStatus = 1;
    await writeJson(badRunPath, badRun);
    await assert.rejects(
      () =>
        buildGraphLock({
          suitePath: fixture.suitePath,
          sourceLockPath: fixture.sourceLockPath,
          plan014RunPath: badRunPath,
          sourceRepositoryRoot: fixture.sourceRoot,
          apiBaseUrl: "http://graph.test",
          expectedMemoryIndexHash: fixture.plan014Run.memoryIndexHash,
          fetchFn: fetchFixture,
        }),
      /validationStatus must be 0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
