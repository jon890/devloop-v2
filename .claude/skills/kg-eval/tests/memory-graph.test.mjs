import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalHash } from "../scripts/memory/suite.mjs";
import { buildGraphContext } from "../scripts/memory/graph-context.mjs";
import { graphEvidenceUsed, hasExactToken } from "../scripts/memory/graph-evidence.mjs";
import { buildMemoryConditionInputs, EXPERIMENTAL_MEMORY_CONDITIONS, MEMORY_CONDITIONS } from "../scripts/memory/condition.mjs";
import { parseArgs, runMemoryEvaluation } from "../scripts/run-memory.mjs";

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
  const repoPath = path.join(root, "source-repo");
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
  git(["commit", "-q", "-m", "target"], repoPath);
  const targetRevision = git(["rev-parse", "HEAD"], repoPath);
  return { repoPath, baseRevision, targetRevision };
}

async function makeMemoryIndex(root) {
  const generationId = `wiki-${"1".repeat(64)}`;
  const projectDirectory = path.join(root, "data", "memory", "tc-ocr");
  const generationDirectory = path.join(projectDirectory, "wiki-generations", generationId);
  await mkdir(generationDirectory, { recursive: true });
  await writeJson(path.join(projectDirectory, "current-wiki.json"), { schemaVersion: 1, generationId });
  await writeJson(path.join(generationDirectory, "index.json"), {
    schemaVersion: 1,
    project: "tc-ocr",
    documents: [],
  });
  return path.join(root, "data");
}

async function makeRunFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "memory-graph-run-"));
  const sourceRepo = await makeSourceRepo(root);
  const dataDir = await makeMemoryIndex(root);
  const suitePath = path.join(root, "suite.json");
  const sourceLockPath = path.join(root, "source-lock.json");
  const graphLockPath = path.join(root, "graph-lock.json");
  const suite = {
    schemaVersion: "memory-eval-suite/v1",
    project: "tc-ocr",
    suiteId: "tc-ocr-memory-foundation",
    title: "fixture",
    sourceSnapshot: "private",
    tasks: [
      { id: "MEM-CODE-001", category: "code-only", taskType: "localized", sourceLockKey: "lock-1", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-CODE-002", category: "code-only", taskType: "localized", sourceLockKey: "lock-2", expectedTrigger: "code-context", tags: [] },
      { id: "MEM-EXP-001", category: "experience-needed", taskType: "policy", sourceLockKey: "lock-3", expectedTrigger: "experience-memory", tags: ["relationship-heavy"] },
      { id: "MEM-EXP-002", category: "experience-needed", taskType: "policy", sourceLockKey: "lock-4", expectedTrigger: "experience-memory", tags: [] },
    ],
  };
  const tasks = suite.tasks.map((task) => ({
    taskId: task.id,
    sourceLockKey: task.sourceLockKey,
    repositoryPath: sourceRepo.repoPath,
    originalRepositoryPath: path.join(root, "original", path.basename(sourceRepo.repoPath)),
    sourceUrl: `https://github.example.internal/team/repo/commit/${sourceRepo.targetRevision}`,
    baseRevision: sourceRepo.baseRevision,
    targetRevision: sourceRepo.targetRevision,
    prompt: `Update service ${task.id}`,
    allowedPaths: ["service.txt"],
    validationCommand: ["node", "--version"],
    oracleQuery: `oracle ${task.id}`,
  }));
  await writeJson(suitePath, suite);
  await writeJson(sourceLockPath, { schemaVersion: "memory-source-lock/v1", suiteId: suite.suiteId, sourceSnapshot: "fixture", tasks });
  await writeJson(graphLockPath, { schemaVersion: "memory-graph-lock/v1", graphStatsHash: `sha256:${"2".repeat(64)}`, tasks: [] });
  return { root, dataDir, suitePath, sourceLockPath, graphLockPath };
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

function graphLock() {
  const stats = { nodes: { Concept: 2 }, relationships: { MENTIONS: 1 } };
  return {
    schemaVersion: "memory-graph-lock/v1",
    graphStatsHash: `sha256:${canonicalHash(stats)}`,
    tasks: [
      {
        taskId: "MEM-EXP-001",
        label: "Concept",
        key: "LB",
        resolvedElementId: "node-lb",
        depth: 1,
        requiredRelationshipType: "MENTIONS",
        sourceRef: { sourceUrl: "https://source.example.invalid/commit/1", targetRevision: "1" },
      },
    ],
  };
}

function fetchFixture({ staleStats = false, staleAnchor = false } = {}) {
  return async (url) => {
    if (url.pathname === "/api/graph/stats") return response(staleStats ? { nodes: { Concept: 3 }, relationships: { MENTIONS: 1 } } : { nodes: { Concept: 2 }, relationships: { MENTIONS: 1 } });
    if (url.pathname === "/api/graph/samples") {
      return response({
        nodes: [{ id: staleAnchor ? "node-other" : "node-lb", label: "Concept", key: "LB", display: "LB", properties: { secret: "drop" } }],
        relationships: [],
        total: 1,
        offset: 0,
        limit: 100,
      });
    }
    if (url.pathname.endsWith("/neighbors")) {
      return response({
        nodes: [{ id: "node-lb", label: "Concept", key: "LB", display: "LB", properties: { secret: "drop" } }],
        relationships: [{ id: "rel-1", type: "MENTIONS", startId: "task-1", endId: "node-lb", properties: { secret: "drop" } }],
      });
    }
    return response({}, false, 404);
  };
}

test("baseline MEMORY_CONDITIONS stay unchanged and experimental conditions are separate", () => {
  assert.deepEqual(MEMORY_CONDITIONS, ["no-memory", "agent-triggered", "oracle-memory"]);
  assert.deepEqual(EXPERIMENTAL_MEMORY_CONDITIONS, ["memory-graph", "automatic"]);
  assert.deepEqual(
    buildMemoryConditionInputs({
      task: { taskId: "T", prompt: "p", baseRevision: "a", allowedPaths: ["x"], validationCommand: ["true"] },
      oracleMemory: { results: [] },
    }).map((input) => input.condition),
    MEMORY_CONDITIONS,
  );
});

test("parseArgs requires graph lock and base URL for memory-graph only", () => {
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "memory-graph"]), /--graph-lock and --graph-base-url/);
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--graph-lock", "g", "--graph-base-url", "u"]), /only supported/);
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "memory-graph", "--graph-lock", "g", "--graph-base-url", "http://graph", "--agent", "claude", "--model", "gpt-5.6-luna", "--effort", "low"]), /agent=codex/);
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "memory-graph", "--graph-lock", "g", "--graph-base-url", "http://graph", "--agent", "codex", "--model", "gpt-5.6-terra", "--effort", "low"]), /model=gpt-5.6-luna/);
  assert.throws(() => parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "memory-graph", "--graph-lock", "g", "--graph-base-url", "http://graph", "--agent", "codex", "--model", "gpt-5.6-luna", "--effort", "medium"]), /effort=low/);
  const parsed = parseArgs(["--suite", "s", "--source-lock", "l", "--conditions", "memory-graph", "--graph-lock", "g", "--graph-base-url", "http://graph", "--agent", "codex", "--model", "gpt-5.6-luna", "--effort", "low"]);
  assert.equal(parsed.graphLockPath, "g");
  assert.equal(parsed.graphBaseUrl, "http://graph");
});

test("graph context resolves exact anchor without raw properties and fails on stale graph", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-graph-context-"));
  try {
    const lockPath = path.join(root, "graph-lock.json");
    await writeJson(lockPath, graphLock());
    const result = await buildGraphContext({ graphLockPath: lockPath, graphBaseUrl: "http://graph.test", taskId: "MEM-EXP-001", fetchFn: fetchFixture() });
    assert.equal(result.context.source.key, "LB");
    assert.equal(result.context.requiredRelationshipType, "MENTIONS");
    assert.equal(result.metrics.graphContextCalls, 3);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    await assert.rejects(() => buildGraphContext({ graphLockPath: lockPath, graphBaseUrl: "http://graph.test", taskId: "MEM-EXP-001", fetchFn: fetchFixture({ staleStats: true }) }), /stats hash changed/);
    await assert.rejects(() => buildGraphContext({ graphLockPath: lockPath, graphBaseUrl: "http://graph.test", taskId: "MEM-EXP-001", fetchFn: fetchFixture({ staleAnchor: true }) }), /elementId changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph context HTTP failures expose only bounded safe code to raw attempts", async () => {
  const fixture = await makeRunFixture();
  try {
    await writeJson(fixture.graphLockPath, graphLock());
    const outPath = path.join(fixture.root, "http-failure.json");
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-EXP-001"],
      conditions: ["memory-graph"],
      repeats: 1,
      timeoutMs: 1000,
      graphLockPath: fixture.graphLockPath,
      graphBaseUrl: "http://user:pass@graph.test/private?token=secret",
      runMemorySearchFn: async () => ({ ok: true, result: { status: 0 }, memory: { results: [{ id: "m1", sourceRefs: [{ url: "https://source.example.invalid/m1" }] }] } }),
      buildGraphContextFn: async (args) =>
        buildGraphContext({
          ...args,
          fetchFn: async () => response({ properties: { secret: "body-secret" } }, false, 503),
        }),
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    const attempt = stored.attempts[0];
    assert.equal(attempt.failureBoundary, "GRAPH");
    assert.equal(attempt.graphFailureReason, "GRAPH_HTTP_503");
    assert.equal(JSON.stringify(attempt).includes("user:pass"), false);
    assert.equal(JSON.stringify(attempt).includes("token=secret"), false);
    assert.equal(JSON.stringify(attempt).includes("body-secret"), false);
    assert.equal(JSON.stringify(attempt).includes("properties"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory-graph run injects oracle Memory and Graph context with flat telemetry", async () => {
  const fixture = await makeRunFixture();
  try {
    const outPath = path.join(fixture.root, "run.json");
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-EXP-001"],
      conditions: ["memory-graph"],
      repeats: 1,
      timeoutMs: 1000,
      graphLockPath: fixture.graphLockPath,
      graphBaseUrl: "http://graph.test",
      runMemorySearchFn: async () => ({ ok: true, result: { status: 0 }, memory: { results: [{ id: "m1", sourceRefs: [{ url: "https://source.example.invalid/m1" }] }] } }),
      buildGraphContextFn: async () => ({
        context: { source: { key: "LB", label: "Concept", sourceUrl: "https://source.example.invalid/commit/1" }, requiredRelationshipType: "MENTIONS" },
        evidence: { resolvedElementId: "node-lb", graphStatsHash: `sha256:${"2".repeat(64)}`, neighbors: { nodes: [], relationships: [] } },
        metrics: { graphContextCalls: 3, graphLatencyMs: 7 },
      }),
      runAgentFn: async ({ cwd, prompt }) => {
        assert.match(prompt, /Memory context:/);
        assert.match(prompt, /Graph context:/);
        assert.match(prompt, /Do not call Graph APIs/);
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg LB service.txt" } }), stderr: "" };
      },
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(stored.graphLockPath, fixture.graphLockPath);
    assert.match(stored.graphLockHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(stored.graphBaseUrl, "http://graph.test");
    const attempt = stored.attempts[0];
    assert.equal(attempt.condition, "memory-graph");
    assert.equal(attempt.graphContextCalls, 3);
    assert.equal(attempt.agentGraphCalls, 0);
    assert.equal(attempt.graphCalls, 3);
    assert.equal(attempt.graphLlmCalls, 0);
    assert.equal(attempt.graphLatencyMs, 7);
    assert.equal(attempt.oracleMemoryProvided, 1);
    assert.equal(attempt.graphEvidenceUsed, true);
    assert.equal(attempt.triggerOutcome, "memory_graph_provided");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory-graph trigger outcome distinguishes missing and contaminated graph use", async () => {
  const fixture = await makeRunFixture();
  try {
    const base = {
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-EXP-001"],
      conditions: ["memory-graph"],
      repeats: 1,
      timeoutMs: 1000,
      graphLockPath: fixture.graphLockPath,
      graphBaseUrl: "http://graph.test",
      runMemorySearchFn: async () => ({ ok: true, result: { status: 0 }, memory: { results: [{ id: "m1", sourceRefs: [{ url: "https://source.example.invalid/m1" }] }] } }),
    };
    await runMemoryEvaluation({
      ...base,
      outPath: path.join(fixture.root, "missing.json"),
      buildGraphContextFn: async () => ({
        context: { source: { key: "LB", label: "Concept", sourceUrl: "https://source.example.invalid/commit/1" }, requiredRelationshipType: "MENTIONS" },
        evidence: { resolvedElementId: "node-lb" },
        metrics: { graphContextCalls: 0, graphLatencyMs: 0 },
      }),
      runAgentFn: async ({ cwd }) => {
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed" }), stderr: "" };
      },
    });
    await runMemoryEvaluation({
      ...base,
      outPath: path.join(fixture.root, "contaminated.json"),
      buildGraphContextFn: async () => ({
        context: { source: { key: "LB", label: "Concept", sourceUrl: "https://source.example.invalid/commit/1" }, requiredRelationshipType: "MENTIONS" },
        evidence: { resolvedElementId: "node-lb" },
        metrics: { graphContextCalls: 3, graphLatencyMs: 1 },
      }),
      runAgentFn: async ({ cwd }) => {
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "curl http://127.0.0.1:3016/api/graph/stats" } }), stderr: "" };
      },
    });
    const missing = JSON.parse(await readFile(path.join(fixture.root, "missing.json"), "utf8")).attempts[0];
    const contaminated = JSON.parse(await readFile(path.join(fixture.root, "contaminated.json"), "utf8")).attempts[0];
    assert.equal(missing.triggerOutcome, "memory_graph_missing");
    assert.equal(contaminated.triggerOutcome, "memory_graph_contaminated_search");
    assert.equal(contaminated.agentGraphCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory-graph programmatic execution requires codex luna low", async () => {
  const fixture = await makeRunFixture();
  try {
    const base = {
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath: path.join(fixture.root, "guard.json"),
      taskIds: ["MEM-EXP-001"],
      conditions: ["memory-graph"],
      repeats: 1,
      graphLockPath: fixture.graphLockPath,
      graphBaseUrl: "http://graph.test",
      dryRun: true,
    };
    await assert.rejects(() => runMemoryEvaluation({ ...base, agent: "claude", agentOptions: { model: "gpt-5.6-luna", effort: "low" } }), /agent=codex/);
    await assert.rejects(() => runMemoryEvaluation({ ...base, agent: "codex", agentOptions: { model: "gpt-5.6-terra", effort: "low" } }), /model=gpt-5.6-luna/);
    await assert.rejects(() => runMemoryEvaluation({ ...base, agent: "codex", agentOptions: { model: "gpt-5.6-luna", effort: "medium" } }), /effort=low/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("graph evidence usage requires exact token evidence and ignores negated/incidental mentions", () => {
  assert.equal(hasExactToken("used LB relation", "LB"), true);
  assert.equal(hasExactToken("used LBLB relation", "LB"), false);
  assert.equal(graphEvidenceUsed({ events: [], graphContext: { source: { key: "LB" }, requiredRelationshipType: "MENTIONS" } }), null);
  assert.equal(graphEvidenceUsed({ events: [{ text: "used mentions relation" }], graphContext: { source: { key: "LB" }, requiredRelationshipType: "MENTIONS" } }), true);
  assert.equal(graphEvidenceUsed({ events: [{ text: "saw LBLB config only" }], graphContext: { source: { key: "LB" }, requiredRelationshipType: "MENTIONS" } }), null);
  assert.equal(graphEvidenceUsed({ events: [{ text: "did not use LB or MENTIONS evidence" }], graphContext: { source: { key: "LB" }, requiredRelationshipType: "MENTIONS" } }), null);
});
