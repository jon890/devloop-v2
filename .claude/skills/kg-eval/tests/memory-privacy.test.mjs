import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectPrivacyNeedles, commonRepositoryRoots, scanPrivacy } from "../scripts/memory/privacy.mjs";
import { validateMemoryReportDigests } from "../scripts/memory/report.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

test("public Memory report digests match validate-memory-suite output", async () => {
  const reportPath = path.resolve("eval/reports/2026-08-12-plan013-memory-foundation.md");
  const suitePath = path.resolve("eval/suites/tc-ocr-memory.json");
  const sourceLockPath = path.resolve("eval/runs/plan013-memory-source-lock.json");
  const result = await validateMemoryReportDigests({ reportPath, suitePath, sourceLockPath });
  assert.equal(result.reportSuiteHash, result.suiteHash);
  assert.equal(result.reportSourceLockHash, result.sourceLockHash);
});
