import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectPrivateInputNeedles, collectPrivacyNeedles, commonRepositoryRoots, scanPrivacy } from "../scripts/memory/privacy.mjs";
import { validateMemoryReportDigests } from "../scripts/memory/report.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sourceLock(root) {
  return {
    schemaVersion: "memory-source-lock/v1",
    suiteId: "tc-ocr-memory-foundation",
    sourceSnapshot: "fixture-private",
    tasks: [
      {
        taskId: "MEM-CODE-001",
        sourceLockKey: "lock-1",
        repositoryPath: path.join(root, "source"),
        repositoryUrl: "https://github.example.internal/team/private-repo.git",
        sourceUrl: "https://github.example.internal/team/private-repo/commit/" + "a".repeat(40),
        baseRevision: "b".repeat(40),
        targetRevision: "a".repeat(40),
        prompt: "private prompt with exact task wording",
        diff: "diff --git a/private b/private",
        transcript: "agent private transcript",
        allowedPaths: ["src/index.js"],
        validationCommand: ["node", "--version"],
        oracleQuery: "private memory oracle query",
      },
    ],
  };
}

test("collects private path, common root, revisions, URL, prompt, diff, transcript, and internal domain needles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-privacy-"));
  try {
    const needles = collectPrivacyNeedles(sourceLock(root));
    const labels = new Set(needles.map((needle) => needle.label));
    assert.deepEqual(commonRepositoryRoots(sourceLock(root).tasks), [root]);
    for (const label of [
      "repositoryRoot",
      "repositoryPath",
      "repositoryUrl",
      "sourceUrl",
      "baseRevision",
      "targetRevision",
      "prompt",
      "diff",
      "transcript",
      "internalDomain",
    ]) {
      assert.equal(labels.has(label), true, label);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes clean tracked files and reports only aggregate counts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-privacy-"));
  try {
    const lockPath = path.join(root, "source-lock.json");
    const reportPath = path.join(root, "report.md");
    await writeJson(lockPath, sourceLock(root));
    await writeFile(reportPath, "# Public report\n\nTasks: 1\n", "utf8");

    const result = await scanPrivacy({ sourceLockPath: lockPath, paths: [reportPath] });

    assert.equal(result.scannedPaths, 1);
    assert.equal(result.violations, 0);
    assert.equal(Array.isArray(result.violationLabels), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects leaks without exposing the matched private values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-privacy-"));
  try {
    const lock = sourceLock(root);
    const lockPath = path.join(root, "source-lock.json");
    const reportPath = path.join(root, "report.md");
    await writeJson(lockPath, lock);
    await writeFile(
      reportPath,
      `Leaked ${root} ${lock.tasks[0].prompt} ${lock.tasks[0].sourceUrl} ${lock.tasks[0].baseRevision} ${lock.tasks[0].diff} ${lock.tasks[0].transcript}\n`,
      "utf8",
    );

    await assert.rejects(
      async () => scanPrivacy({ sourceLockPath: lockPath, paths: [reportPath] }),
      (error) => {
        assert.match(error.message, /privacy scan failed/);
        assert.equal(JSON.stringify(error.result).includes(lock.tasks[0].prompt), false);
        assert.equal(JSON.stringify(error.result).includes(lock.tasks[0].sourceUrl), false);
        assert.equal(JSON.stringify(error.result).includes(lock.tasks[0].baseRevision), false);
        assert.equal(JSON.stringify(error.result).includes(lock.tasks[0].targetRevision), false);
        assert.deepEqual(error.result.violationLabels, [
          "report.md:baseRevision",
          "report.md:diff",
          "report.md:internalDomain",
          "report.md:prompt",
          "report.md:repositoryRoot",
          "report.md:sourceUrl",
          "report.md:targetRevision",
          "report.md:transcript",
        ]);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private retrieval inputs add query and Memory ID needles without requiring source lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-privacy-"));
  try {
    const privateInputsPath = path.join(root, "retrieval-misses.json");
    const reportPath = path.join(root, "report.md");
    const privateInput = {
      schemaVersion: "memory-retrieval-miss-lock/v1",
      missCount: 1,
      misses: [
        {
          taskId: "MEM-EXP-001",
          query: "private retrieval query exact words",
          requiredMemoryIds: ["mem-private-required"],
          retrievedMemoryIds: ["mem-private-other"],
        },
      ],
    };
    await writeJson(privateInputsPath, privateInput);
    const needles = await collectPrivateInputNeedles([privateInputsPath]);
    assert.deepEqual(
      needles.map((needle) => needle.label).sort(),
      ["memoryId", "memoryId", "privateQuery"],
    );

    await writeFile(reportPath, "Decision: NO_CHANGE\n", "utf8");
    const clean = await scanPrivacy({ privateInputPaths: [privateInputsPath], paths: [reportPath] });
    assert.equal(clean.violations, 0);

    await writeFile(reportPath, "Leaked private retrieval query exact words and mem-private-required\n", "utf8");
    await assert.rejects(
      async () => scanPrivacy({ privateInputPaths: [privateInputsPath], paths: [reportPath] }),
      (error) => {
        assert.match(error.message, /privacy scan failed/);
        assert.equal(JSON.stringify(error.result).includes(privateInput.misses[0].query), false);
        assert.equal(JSON.stringify(error.result).includes(privateInput.misses[0].requiredMemoryIds[0]), false);
        assert.deepEqual(error.result.violationLabels, ["report.md:memoryId", "report.md:privateQuery"]);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private graph inputs add anchor, URL, original path, node id, and property needles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-privacy-graph-"));
  try {
    const graphLockPath = path.join(root, "graph-lock.json");
    const reportPath = path.join(root, "report.md");
    const graphLock = {
      schemaVersion: "memory-graph-lock/v1",
      apiBaseUrl: "http://127.0.0.1:3016",
      tasks: [
        {
          taskId: "MEM-EXP-002",
          key: "cab api",
          resolvedElementId: "node-private-123",
          sourceRef: { sourceUrl: "https://github.example.internal/team/private/commit/" + "a".repeat(40) },
          sourceRepositoryResolution: {
            originalRepositoryPath: path.join(root, "OCR.Admin"),
          },
          neighbors: {
            nodes: [{ id: "neighbor-private-456", label: "Concept", key: "secret graph key", display: "secret graph key", properties: { secret: "graph-property-secret" } }],
            relationships: [],
          },
        },
      ],
    };
    await writeJson(graphLockPath, graphLock);
    const needles = await collectPrivateInputNeedles([graphLockPath]);
    const labels = new Set(needles.map((needle) => needle.label));
    for (const label of ["apiBaseUrl", "sourceUrl", "originalRepositoryPath", "resolvedElementId", "graphAnchorKey", "graphProperty"]) {
      assert.equal(labels.has(label), true, label);
    }
    await writeFile(reportPath, "Clean public aggregate only\n", "utf8");
    assert.equal((await scanPrivacy({ privateInputPaths: [graphLockPath], paths: [reportPath] })).violations, 0);
    await writeFile(reportPath, `Leak cab api node-private-123 graph-property-secret ${graphLock.tasks[0].sourceRef.sourceUrl}\n`, "utf8");
    await assert.rejects(
      () => scanPrivacy({ privateInputPaths: [graphLockPath], paths: [reportPath] }),
      (error) => {
        assert.match(error.message, /privacy scan failed/);
        assert.equal(JSON.stringify(error.result).includes("cab api"), false);
        assert.deepEqual(error.result.violationLabels, ["report.md:graphAnchorKey", "report.md:graphProperty", "report.md:internalDomain", "report.md:resolvedElementId", "report.md:sourceUrl"]);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic private inputs add repository, revision, prompt, transcript path, URL, and raw context needles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-privacy-automatic-"));
  try {
    const automaticRunPath = path.join(root, "automatic-run.json");
    const reportPath = path.join(root, "report.md");
    const automaticRun = {
      schemaVersion: "memory-run/v1",
      sourceRepositoryRoot: path.join(root, "OCR"),
      taskInputs: [
        {
          taskId: "MEM-EXP-001",
          baseRevision: "a".repeat(40),
          targetRevision: "b".repeat(40),
          prompt: "private automatic prompt words",
          oracleQuery: "private automatic oracle query",
        },
      ],
      resolvedRepositories: [
        {
          taskId: "MEM-EXP-001",
          originalRepositoryPath: path.join(root, "OCR", "OCR.API"),
          originalRepositoryBasename: "OCR.API",
          resolvedRepositoryPath: path.join(root, "OCR", "OCR.API"),
          sourceUrl: "https://github.example.internal/team/OCR.API/commit/" + "a".repeat(40),
        },
      ],
      attempts: [
        {
          taskId: "MEM-EXP-001",
          condition: "automatic",
          repetition: 1,
          stdoutTranscriptPath: "eval/runs/transcripts/private-automatic.stdout.jsonl",
          stderrTranscriptPath: "eval/runs/transcripts/private-automatic.stderr.txt",
          automaticContext: "private automatic raw context",
          provenance: "private source provenance",
        },
      ],
    };
    await writeJson(automaticRunPath, automaticRun);
    const needles = await collectPrivateInputNeedles([automaticRunPath]);
    const labels = new Set(needles.map((needle) => needle.label));
    for (const label of [
      "sourceRepositoryRoot",
      "originalRepositoryPath",
      "originalRepositoryBasename",
      "resolvedRepositoryPath",
      "sourceUrl",
      "internalDomain",
      "baseRevision",
      "targetRevision",
      "prompt",
      "oracleQuery",
      "stdoutTranscriptPath",
      "stderrTranscriptPath",
      "automaticContext",
      "provenance",
    ]) {
      assert.equal(labels.has(label), true, label);
    }

    await writeFile(reportPath, "Public aggregate only\n", "utf8");
    assert.equal((await scanPrivacy({ privateInputPaths: [automaticRunPath], paths: [reportPath] })).violations, 0);

    await writeFile(reportPath, `Leak OCR.API ${automaticRun.taskInputs[0].prompt} private automatic raw context ${automaticRun.resolvedRepositories[0].sourceUrl}\n`, "utf8");
    await assert.rejects(
      () => scanPrivacy({ privateInputPaths: [automaticRunPath], paths: [reportPath] }),
      (error) => {
        assert.match(error.message, /privacy scan failed/);
        assert.equal(JSON.stringify(error.result).includes(automaticRun.taskInputs[0].prompt), false);
        assert.deepEqual(error.result.violationLabels, [
          "report.md:automaticContext",
          "report.md:baseRevision",
          "report.md:internalDomain",
          "report.md:originalRepositoryBasename",
          "report.md:prompt",
          "report.md:sourceUrl",
        ]);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private input scan fails when every configured input is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-privacy-"));
  try {
    const reportPath = path.join(root, "report.md");
    await writeFile(reportPath, "Decision: NO_CHANGE\n", "utf8");
    await assert.rejects(
      async () => scanPrivacy({ privateInputPaths: [path.join(root, "missing.json")], paths: [reportPath] }),
      /private inputs not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const PLAN013_SOURCE_LOCK = path.resolve("eval/runs/plan013-memory-source-lock.json");

test("public Memory report digests match validate-memory-suite output", { skip: !(await exists(PLAN013_SOURCE_LOCK)) }, async () => {
  const reportPath = path.resolve("eval/reports/2026-08-12-plan013-memory-foundation.md");
  const suitePath = path.resolve("eval/suites/tc-ocr-memory.json");
  const sourceLockPath = PLAN013_SOURCE_LOCK;
  const result = await validateMemoryReportDigests({ reportPath, suitePath, sourceLockPath });
  assert.equal(result.reportSuiteHash, result.suiteHash);
  assert.equal(result.reportSourceLockHash, result.sourceLockHash);
});
