import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertAcceptedAttempts,
  buildAttemptSchedule,
  detectWorkspaceContamination,
  memorySearchArgv,
  memorySearchCommand,
  parseArgs,
  runMemoryEvaluation,
  usableMemorySearchResult,
} from "../scripts/run-memory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(__dirname, "../scripts/run-memory.mjs");

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
    wikiGenerationId: generationId,
    extractionGenerationId: `ext-${"2".repeat(64)}`,
    sourceGenerationId: `src-${"3".repeat(64)}`,
    sourceManifestHash: `sha256:${"4".repeat(64)}`,
    extractionManifestHash: `sha256:${"5".repeat(64)}`,
    complete: false,
    documents: [],
  });
  return path.join(root, "data");
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "run-memory-"));
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
  return { root, dataDir, suitePath, sourceLockPath, sourceRepo };
}

test("parses help, dry-run, and bounded execution options", () => {
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  const parsed = parseArgs([
    "--suite",
    "suite.json",
    "--source-lock",
    "lock.json",
    "--agent",
    "codex",
    "--tasks",
    "A,B",
    "--conditions",
    "agent-triggered",
    "--repeats",
    "2",
    "--schedule",
    "interleaved",
    "--require-expected-trigger",
  ]);
  assert.equal(parsed.agent, "codex");
  assert.deepEqual(parsed.taskIds, ["A", "B"]);
  assert.deepEqual(parsed.conditions, ["agent-triggered"]);
  assert.equal(parsed.repeats, 2);
  assert.equal(parsed.schedule, "interleaved");
  assert.equal(parsed.requireExpectedTrigger, true);
});

test("builds deterministic default and interleaved schedules", () => {
  const tasks = [{ id: "T1" }, { id: "T2" }];
  const conditions = ["no-memory", "agent-triggered", "oracle-memory"];
  assert.deepEqual(
    buildAttemptSchedule({ tasks, conditions, repeats: 2, schedule: "default" }).map(({ task, condition, repetition }) => [task.id, condition, repetition]),
    [
      ["T1", "no-memory", 1],
      ["T1", "no-memory", 2],
      ["T1", "agent-triggered", 1],
      ["T1", "agent-triggered", 2],
      ["T1", "oracle-memory", 1],
      ["T1", "oracle-memory", 2],
      ["T2", "no-memory", 1],
      ["T2", "no-memory", 2],
      ["T2", "agent-triggered", 1],
      ["T2", "agent-triggered", 2],
      ["T2", "oracle-memory", 1],
      ["T2", "oracle-memory", 2],
    ],
  );
  assert.deepEqual(
    buildAttemptSchedule({ tasks, conditions, repeats: 2, schedule: "interleaved" }).map(({ task, condition, repetition }) => [task.id, condition, repetition]),
    [
      ["T1", "no-memory", 1],
      ["T1", "agent-triggered", 1],
      ["T1", "oracle-memory", 1],
      ["T1", "no-memory", 2],
      ["T1", "agent-triggered", 2],
      ["T1", "oracle-memory", 2],
      ["T2", "no-memory", 1],
      ["T2", "agent-triggered", 1],
      ["T2", "oracle-memory", 1],
      ["T2", "no-memory", 2],
      ["T2", "agent-triggered", 2],
      ["T2", "oracle-memory", 2],
    ],
  );
});

test("builds the archived-workspace Memory search command with devloop root and data dir", () => {
  const argv = memorySearchArgv({ query: "exact oracle", dataDir: "./data", devloopRoot: "/repo/root" });
  assert.deepEqual(argv.slice(0, 5), ["pnpm", "--dir", "/repo/root", "--silent", "memory-search"]);
  assert(argv.includes("--project"));
  assert(argv.includes("tc-ocr"));
  assert(argv.includes("--allow-incomplete"));
  assert.match(memorySearchCommand({ query: "can't leak", dataDir: "./data dir", devloopRoot: "/repo/root" }), /^'pnpm' '--dir'/);
});

test("detects forbidden workspace paths across multi-line commands without flagging memory-search", () => {
  const commandEvents = [
    "python <<'PY'\nfrom pathlib import Path\nprint(Path('../MEM-CODE-001-no-memory-1/service.txt').read_text())\nPY",
    "node <<'JS'\nrequire('fs').readFileSync('eval/runs/workspaces/MEM-CODE-001-no-memory-1/service.txt','utf8')\nJS",
    "cp ../MEM-CODE-001-no-memory-1/service.txt ./copied.txt",
    "awk '{print}' memory-diffs/MEM-CODE-001-no-memory-1.patch",
    "wc -l transcripts/MEM-CODE-001-no-memory-1.stdout.jsonl",
    "wc -l ../../transcripts/MEM-CODE-001-no-memory-1.stdout.jsonl",
    "cat /tmp/x/eval/runs/workspaces/MEM-CODE-001-no-memory-1/service.txt",
  ].map((command) => ({ type: "item.completed", item: { type: "command_execution", command } }));
  assert.deepEqual(detectWorkspaceContamination(commandEvents), {
    workspaceContamination: true,
    workspaceContaminationCount: 7,
  });

  const generated = memorySearchCommand({ query: "MEM-CODE-001", dataDir: "/repo/root/apps/pipeline/data", devloopRoot: "/repo/root" });
  assert.deepEqual(
    detectWorkspaceContamination([{ type: "item.completed", item: { type: "command_execution", command: generated } }]),
    {
      workspaceContamination: false,
      workspaceContaminationCount: 0,
    },
  );
  assert.deepEqual(
    detectWorkspaceContamination(
      [{ type: "item.completed", item: { type: "command_execution", command: "git -C /tmp/devloop-memory-eval-abc123/MEM-EXP-001-agent-triggered-3/.git status" } }],
      { currentWorkspacePath: "/tmp/devloop-memory-eval-abc123/MEM-EXP-001-agent-triggered-3" },
    ),
    {
      workspaceContamination: false,
      workspaceContaminationCount: 0,
    },
  );
  assert.deepEqual(
    detectWorkspaceContamination([{ type: "item.completed", item: { type: "command_execution", command: "cat ../MEM-CODE-001-no-memory-1/service.txt" } }], {
      currentWorkspacePath: "/tmp/devloop-memory-eval-abc123/MEM-EXP-001-agent-triggered-3",
    }),
    {
      workspaceContamination: true,
      workspaceContaminationCount: 1,
    },
  );
  assert.deepEqual(
    detectWorkspaceContamination([{ type: "item.completed", item: { type: "command_execution", command: "cat /tmp/x/eval/runs/transcripts/MEM-CODE-001-no-memory-1.stdout.jsonl" } }], {
      currentWorkspacePath: "/tmp/devloop-memory-eval-abc123/MEM-EXP-001-agent-triggered-3",
    }),
    {
      workspaceContamination: true,
      workspaceContaminationCount: 1,
    },
  );
});

test("prints help without requiring private inputs", () => {
  const result = spawnSync(process.execPath, [RUNNER, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--require-expected-trigger/);
});

test("dry-run validates suite and reports private-safe aggregate identity", async () => {
  const fixture = await makeFixture();
  try {
    const result = await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath: path.join(fixture.root, "run.json"),
      conditions: ["agent-triggered"],
      repeats: 1,
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.taskCount, 4);
    assert.equal(result.plannedAttempts, 4);
    assert.match(result.memoryIndexHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("executes one fake agent attempt, records telemetry, and resumes without duplicate attempts", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "run.json");
    const fakeEvents = [
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
      { type: "item.completed", item: { type: "command_execution", command: "rg service" } },
      { type: "item.completed", item: { type: "command_execution", command: "pnpm --silent memory-search -- --query q" } },
    ];
    const options = {
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-EXP-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      runAgentFn: async ({ cwd, prompt }) => {
        assert.doesNotMatch(prompt, /classified as experience-needed/);
        assert.doesNotMatch(prompt, /run this exact Experience Memory search command once before editing/);
        assert.match(prompt, /if Experience Memory search is warranted/);
        assert.match(prompt, /pnpm.*memory-search/s);
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: fakeEvents.map((event) => JSON.stringify(event)).join("\n"), stderr: "" };
      },
    };

    const first = await runMemoryEvaluation(options);
    const firstBytes = await readFile(outPath, "utf8");
    const second = await runMemoryEvaluation(options);
    const secondBytes = await readFile(outPath, "utf8");
    const stored = JSON.parse(await readFile(outPath, "utf8"));

    assert.equal(first.completedAttempts, 1);
    assert.equal(second.completedAttempts, 0);
    assert.equal(secondBytes, firstBytes);
    assert.equal(stored.attempts.length, 1);
    assert.equal(stored.attempts[0].memoryCalls, 1);
    assert.equal(stored.attempts[0].agentMemoryCalls, 1);
    assert.equal(stored.attempts[0].oracleMemoryProvided, 0);
    assert.equal(stored.attempts[0].triggerOutcome, "expected_search");
    assert.deepEqual(stored.attempts[0].retrievalObservations, [
      {
        sourceRunKey: "MEM-EXP-001-agent-triggered-1",
        query: "q",
        topK: 10,
        requiredMemoryIds: [],
        retrievedMemoryIds: [],
        memoryIndexHash: null,
        outcome: "unobserved",
      },
    ]);
    await access(stored.attempts[0].stdoutTranscriptPath);
    await access(stored.attempts[0].stderrTranscriptPath);
    assert.equal(stored.attempts[0].sourceReads, 1);
    assert.equal(stored.attempts[0].inputTokens, 10);
    assert.equal(stored.attempts[0].taskSuccess, true);
    assert.equal(stored.agent, "codex");
    assert.deepEqual(stored.agentOptions, { model: "gpt-5.6-luna", effort: "low", permissionMode: null });
    assert.match(stored.attempts[0].workspaceDiffHash, /^[0-9a-f]{64}$/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("executionPlan mismatches fail before Agent execution", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "execution-plan.json");
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-CODE-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      schedule: "default",
      timeoutMs: 1000,
      maxOutputBytes: 2048,
      runAgentFn: async ({ cwd }) => {
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed" }), stderr: "" };
      },
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.deepEqual(stored.executionPlan, {
      conditions: ["agent-triggered"],
      repeats: 1,
      schedule: "default",
      requireExpectedTrigger: false,
      timeoutMs: 1000,
      maxOutputBytes: 2048,
    });

    for (const changed of [
      { conditions: ["no-memory"] },
      { repeats: 2 },
      { schedule: "interleaved" },
      { requireExpectedTrigger: true },
      { timeoutMs: 2000 },
      { maxOutputBytes: 4096 },
    ]) {
      await assert.rejects(
        () =>
          runMemoryEvaluation({
            suitePath: fixture.suitePath,
            sourceLockPath: fixture.sourceLockPath,
            dataDir: fixture.dataDir,
            outPath,
            agent: "codex",
            agentOptions: { model: "gpt-5.6-luna", effort: "low" },
            taskIds: ["MEM-CODE-001"],
            conditions: ["agent-triggered"],
            repeats: 1,
            schedule: "default",
            timeoutMs: 1000,
            maxOutputBytes: 2048,
            ...changed,
            runAgentFn: async () => {
              throw new Error("executionPlan mismatch must stop before Agent execution");
            },
          }),
        /conditions differ: executionPlan/,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("started non-zero Agent result is appended and does not fail utility acceptance", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "started-failure.json");
    const result = await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-CODE-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      runAgentFn: async () => ({
        status: 1,
        signal: null,
        timedOut: false,
        outputOverflow: null,
        stdout: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg service" } }),
        stderr: "failed after start",
      }),
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(result.completedAttempts, 1);
    assert.equal(stored.attempts.length, 1);
    assert.equal(stored.attempts[0].status, 1);
    assert.equal(stored.attempts[0].sourceReads, 1);
    assert.equal(stored.availabilityFailures.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("spawn availability failure is stored without consuming the attempt", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "spawn-failure.json");
    const result = await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-CODE-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      runAgentFn: async () => {
        throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      },
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(result.completedAttempts, 0);
    assert.equal(result.availabilityFailures, 1);
    assert.deepEqual(stored.attempts, []);
    assert.deepEqual(stored.availabilityFailures, [
      {
        taskId: "MEM-CODE-001",
        condition: "agent-triggered",
        repetition: 1,
        normalizedCode: "agent_spawn_failed",
      },
    ]);
    await assert.rejects(() => access(path.join(path.dirname(outPath), "active-workspace")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sequential attempts remove prior active workspace while preserving result artifacts and source repo", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "sequential.json");
    const sourceBefore = git(["status", "--short"], fixture.sourceRepo.repoPath);
    const seenCwds = [];
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-CODE-001"],
      conditions: ["no-memory", "agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      runAgentFn: async ({ cwd }) => {
        if (seenCwds.length === 1) {
          await assert.rejects(() => access(seenCwds[0]));
          assert.notEqual(path.dirname(path.dirname(cwd)), path.dirname(outPath));
          assert.match(path.basename(path.dirname(cwd)), /^devloop-memory-eval-/);
        }
        seenCwds.push(cwd);
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed" }), stderr: "" };
      },
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(stored.attempts.length, 2);
    assert.notEqual(path.dirname(seenCwds[0]), path.dirname(seenCwds[1]));
    assert.match(path.basename(path.dirname(seenCwds[0])), /^devloop-memory-eval-/);
    assert.match(path.basename(path.dirname(seenCwds[1])), /^devloop-memory-eval-/);
    await access(stored.attempts[0].stdoutTranscriptPath);
    await access(stored.attempts[1].stdoutTranscriptPath);
    await access(path.join(path.dirname(outPath), "memory-diffs", "MEM-CODE-001-no-memory-1.patch"));
    await access(path.join(path.dirname(outPath), "memory-diffs", "MEM-CODE-001-agent-triggered-1.patch"));
    assert.equal(git(["status", "--short"], fixture.sourceRepo.repoPath), sourceBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("oracle failure cleans active workspace before returning the error", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "oracle-cleanup.json");
    await assert.rejects(
      () =>
        runMemoryEvaluation({
          suitePath: fixture.suitePath,
          sourceLockPath: fixture.sourceLockPath,
          dataDir: fixture.dataDir,
          outPath,
          agent: "codex",
          taskIds: ["MEM-EXP-001"],
          conditions: ["oracle-memory"],
          repeats: 1,
          timeoutMs: 1000,
          runMemorySearchFn: async () => ({ ok: false, reason: "emptyResults", result: { status: 0 }, memory: { results: [] } }),
          runAgentFn: async () => {
            throw new Error("oracle failure must stop before Agent execution");
          },
        }),
      /oracle memory unavailable/,
    );
    await assert.rejects(() => access(path.join(path.dirname(outPath), "active-workspace")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sibling benchmark artifact command access records contamination and fails acceptance", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "contamination.json");
    await assert.rejects(
      () =>
        runMemoryEvaluation({
          suitePath: fixture.suitePath,
          sourceLockPath: fixture.sourceLockPath,
          dataDir: fixture.dataDir,
          outPath,
          agent: "codex",
          agentOptions: { model: "gpt-5.6-luna", effort: "low" },
          taskIds: ["MEM-CODE-001"],
          conditions: ["agent-triggered"],
          repeats: 1,
          timeoutMs: 1000,
          runAgentFn: async ({ cwd }) => {
            await writeFile(path.join(cwd, "service.txt"), "changed\n");
            return {
              status: 0,
              signal: null,
              timedOut: false,
              outputOverflow: null,
              stdout: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat ../MEM-CODE-001-no-memory-1/service.txt" } }),
              stderr: "",
            };
          },
        }),
      /memory run acceptance failed/,
    );
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(stored.attempts[0].workspaceContamination, true);
    assert.equal(stored.attempts[0].workspaceContaminationCount, 1);
    assert.equal(Object.hasOwn(stored.attempts[0], "workspaceContaminationCommands"), false);
    assert.equal(stored.attempts[0].failureBoundary, "MEMORY");
    await assert.rejects(() => access(path.join(path.dirname(outPath), "active-workspace")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resumed memory run rejects changed agent options but accepts canonical nulls", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "locked-run.json");
    const baseOptions = {
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-CODE-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      runAgentFn: async ({ cwd }) => {
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed" }), stderr: "" };
      },
    };

    const first = await runMemoryEvaluation(baseOptions);
    const sameCanonical = await runMemoryEvaluation({
      ...baseOptions,
      agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: null },
      runAgentFn: async () => {
        throw new Error("same canonical options should resume without executing");
      },
    });
    assert.equal(first.completedAttempts, 1);
    assert.equal(sameCanonical.completedAttempts, 0);

    await assert.rejects(() => runMemoryEvaluation({ ...baseOptions, agent: "claude" }), /conditions differ: agent/);
    await assert.rejects(() => runMemoryEvaluation({ ...baseOptions, agentOptions: { ...baseOptions.agentOptions, model: "gpt-5.6-terra" } }), /conditions differ: agentOptions/);
    await assert.rejects(() => runMemoryEvaluation({ ...baseOptions, agentOptions: { ...baseOptions.agentOptions, effort: "medium" } }), /conditions differ: agentOptions/);
    await assert.rejects(
      () => runMemoryEvaluation({ ...baseOptions, agentOptions: { ...baseOptions.agentOptions, permissionMode: "workspace-write" } }),
      /conditions differ: agentOptions/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("isolates active workspaces and preserves transcripts and diffs under the output directory", async () => {
  const fixture = await makeFixture();
  try {
    const isolated = path.join(fixture.root, "isolated-runs");
    const outPath = path.join(isolated, "run.json");
    const globalWorkspace = path.join(process.cwd(), "eval", "runs", "workspaces", "MEM-CODE-001-agent-triggered-1");
    const globalBefore = await stat(globalWorkspace).catch(() => null);
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-CODE-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      runAgentFn: async ({ cwd }) => {
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }), stderr: "" };
      },
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    await assert.rejects(() => access(path.join(isolated, "active-workspace")));
    await assert.rejects(() => access(path.join(isolated, "workspaces")));
    await access(stored.attempts[0].stdoutTranscriptPath);
    await access(stored.attempts[0].stderrTranscriptPath);
    await access(path.join(isolated, "memory-diffs", "MEM-CODE-001-agent-triggered-1.patch"));
    const globalAfter = await stat(globalWorkspace).catch(() => null);
    assert.equal(globalAfter?.mtimeMs ?? null, globalBefore?.mtimeMs ?? null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("require-expected-trigger only forces the prompt for experience-needed agent-triggered smokes", async () => {
  const fixture = await makeFixture();
  try {
    const prompts = [];
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath: path.join(fixture.root, "forced-exp.json"),
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-EXP-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      requireExpectedTrigger: true,
      runAgentFn: async ({ cwd, prompt }) => {
        prompts.push(prompt);
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return {
          status: 0,
          signal: null,
          timedOut: false,
          outputOverflow: null,
          stdout: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pnpm --silent memory-search -- --query q" } }),
          stderr: "",
        };
      },
    });
    assert.match(prompts[0], /classified as experience-needed/);
    assert.match(prompts[0], /run this exact Experience Memory search command once before editing/);

    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath: path.join(fixture.root, "forced-code.json"),
      agent: "codex",
      agentOptions: { model: "gpt-5.6-luna", effort: "low" },
      taskIds: ["MEM-CODE-001"],
      conditions: ["agent-triggered"],
      repeats: 1,
      timeoutMs: 1000,
      requireExpectedTrigger: true,
      runAgentFn: async ({ cwd, prompt }) => {
        prompts.push(prompt);
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed" }), stderr: "" };
      },
    });
    assert.doesNotMatch(prompts[1], /classified as experience-needed/);
    assert.doesNotMatch(prompts[1], /run this exact Experience Memory search command once before editing/);
    assert.match(prompts[1], /if Experience Memory search is warranted/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("oracle-memory fails closed before Agent execution when search result is unusable", async () => {
  const fixture = await makeFixture();
  try {
    let agentCalls = 0;
    for (const [reason, memory] of [
      ["missingResults", {}],
      ["emptyResults", { results: [] }],
      ["missingHttpSourceRef", { results: [{ title: "memory", sourceRefs: [{ url: "file:///private" }] }] }],
    ]) {
      const outPath = path.join(fixture.root, `${reason}.json`);
      await assert.rejects(
        () =>
          runMemoryEvaluation({
            suitePath: fixture.suitePath,
            sourceLockPath: fixture.sourceLockPath,
            dataDir: fixture.dataDir,
            outPath,
            agent: "codex",
            taskIds: ["MEM-EXP-001"],
            conditions: ["oracle-memory"],
            repeats: 1,
            timeoutMs: 1000,
            runMemorySearchFn: async () => ({ ok: false, reason, result: { status: 0 }, memory }),
            runAgentFn: async () => {
              agentCalls += 1;
              return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: "", stderr: "" };
            },
          }),
        (error) => {
          assert.match(error.message, /oracle memory unavailable/);
          assert.equal(error.message.includes(fixture.root), false);
          assert.equal(error.failures[reason], 1);
          return true;
        },
      );
    }
    assert.equal(agentCalls, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("oracle-memory counts exactly one successful usable oracle injection", async () => {
  const fixture = await makeFixture();
  try {
    const outPath = path.join(fixture.root, "oracle-run.json");
    assert.deepEqual(usableMemorySearchResult({ results: [{ sourceRefs: [{ url: "https://source.example.invalid/ref" }] }] }), { ok: true });
    await runMemoryEvaluation({
      suitePath: fixture.suitePath,
      sourceLockPath: fixture.sourceLockPath,
      dataDir: fixture.dataDir,
      outPath,
      agent: "codex",
      taskIds: ["MEM-EXP-001"],
      conditions: ["oracle-memory"],
      repeats: 1,
      timeoutMs: 1000,
      runMemorySearchFn: async () => ({ ok: true, result: { status: 0 }, memory: { results: [{ sourceRefs: [{ url: "https://source.example.invalid/ref" }] }] } }),
      runAgentFn: async ({ cwd, prompt }) => {
        assert.match(prompt, /Memory context/);
        await writeFile(path.join(cwd, "service.txt"), "changed\n");
        return { status: 0, signal: null, timedOut: false, outputOverflow: null, stdout: JSON.stringify({ type: "turn.completed" }), stderr: "" };
      },
    });
    const stored = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(stored.attempts[0].memoryCalls, 1);
    assert.equal(stored.attempts[0].agentMemoryCalls, 0);
    assert.equal(stored.attempts[0].oracleMemoryProvided, 1);
    assert.equal(stored.attempts[0].taskSuccess, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("voluntary trigger mismatch is recorded by default and only fails when required", () => {
  const input = {
    attempts: [
      {
        taskId: "MEM-EXP-001",
        condition: "agent-triggered",
        repetition: 1,
        status: 0,
        timedOut: false,
        outputOverflow: null,
        validationStatus: 0,
        taskSuccess: true,
        memoryCalls: 0,
      },
    ],
    selected: [{ publicTask: { id: "MEM-EXP-001", category: "experience-needed" } }],
    conditions: ["agent-triggered"],
    repeats: 1,
  };
  assert.doesNotThrow(() => assertAcceptedAttempts(input));
  assert.throws(
    () => assertAcceptedAttempts({ ...input, requireExpectedTrigger: true }),
    (error) => {
      assert.match(error.message, /memory run acceptance failed/);
      assert.equal(error.message.includes("MEM-EXP-001"), false);
      assert.equal(error.failures.triggerMismatch, 1);
      return true;
    },
  );
});

test("oracle-memory accepts exactly one injected oracle and rejects Agent memory search contamination", () => {
  assert.doesNotThrow(() =>
    assertAcceptedAttempts({
      attempts: [
        {
          taskId: "MEM-EXP-001",
          condition: "oracle-memory",
          repetition: 1,
          memoryCalls: 1,
          agentMemoryCalls: 0,
          oracleMemoryProvided: 1,
        },
      ],
      selected: [{ publicTask: { id: "MEM-EXP-001", category: "experience-needed" } }],
      conditions: ["oracle-memory"],
      repeats: 1,
    }),
  );
  assert.throws(
    () =>
      assertAcceptedAttempts({
        attempts: [
          {
            taskId: "MEM-EXP-001",
            condition: "oracle-memory",
            repetition: 1,
            memoryCalls: 2,
            agentMemoryCalls: 1,
            oracleMemoryProvided: 1,
          },
        ],
        selected: [{ publicTask: { id: "MEM-EXP-001", category: "experience-needed" } }],
        conditions: ["oracle-memory"],
        repeats: 1,
      }),
    /memory run acceptance failed/,
  );
});
