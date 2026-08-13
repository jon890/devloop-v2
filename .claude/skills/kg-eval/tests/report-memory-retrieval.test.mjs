import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRetrievalReport, canonicalBytes } from "../scripts/report-memory-retrieval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REPORT_CLI = path.join(REPO_ROOT, ".claude/skills/kg-eval/scripts/report-memory-retrieval.mjs");
const HASH = `sha256:${"a".repeat(64)}`;

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function missLock(overrides = {}) {
  return {
    schemaVersion: "memory-retrieval-miss-lock/v1",
    sourceRunHash: "source-run-hash",
    utilityReportHash: "utility-report-hash",
    utilityPrivateMissLockHash: "private-miss-lock-hash",
    suiteHash: "suite-hash",
    memoryIndexHash: HASH,
    retrievalObservationComplete: true,
    missCount: 0,
    corpus: null,
    misses: [],
    ...overrides,
  };
}

function comparison() {
  return {
    adapters: ["lexical", "sqlite", "hybrid"].map((adapter, index) => ({
      adapter,
      topK: 10,
      memoryIndexHash: HASH,
      missCount: 1,
      recallAtK: index / 2,
      searchLatencyMsMedian: 10 + index,
      buildTimeMs: 100 + index,
      indexSizeBytes: 1000 + index,
      rssDeltaBytes: 2000 + index,
      dependencyCount: index,
      serviceCount: 0,
    })),
  };
}

test("zero miss report is deterministic and does not require comparison input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retrieval-report-"));
  try {
    const missesPath = path.join(root, "misses.json");
    await writeJson(missesPath, missLock());
    const first = await buildRetrievalReport({ missesPath, comparisonPath: path.join(root, "missing-comparison.json") });
    const second = await buildRetrievalReport({ missesPath, comparisonPath: null });
    assert.equal(first.decision, "NO_CHANGE");
    assert.equal(first.missCount, 0);
    assert.equal(first.adaptersEvaluated, 0);
    assert.deepEqual(first.adapters, []);
    assert.equal(canonicalBytes(first), canonicalBytes(second));
    assert.equal(canonicalBytes(first).includes("private query"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero miss report still rejects incomplete retrieval observations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retrieval-report-"));
  try {
    const missesPath = path.join(root, "misses.json");
    await writeJson(missesPath, missLock({ retrievalObservationComplete: false }));
    await assert.rejects(async () => buildRetrievalReport({ missesPath, comparisonPath: null }), /observation incomplete/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-zero miss count requires comparison and validates shared corpus and top-k", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retrieval-report-"));
  try {
    const missesPath = path.join(root, "misses.json");
    await writeJson(
      missesPath,
      missLock({
        missCount: 1,
        corpus: { corpusIndexHash: HASH },
        misses: [{ taskId: "MEM-EXP-001", query: "private query", requiredMemoryIds: ["mem-required"], retrievedMemoryIds: ["mem-other"], sourceRunKeys: ["run-1"], topK: 10 }],
      }),
    );
    await assert.rejects(
      async () => buildRetrievalReport({ missesPath, comparisonPath: path.join(root, "missing-comparison.json") }),
      /comparison input missing/,
    );

    const comparisonPath = path.join(root, "comparison.json");
    await writeJson(comparisonPath, comparison());
    const report = await buildRetrievalReport({ missesPath, comparisonPath });
    assert.equal(report.decision, "INCONCLUSIVE");
    assert.equal(report.adaptersEvaluated, 3);
    assert.deepEqual(report.adapters.map((adapter) => adapter.adapter), ["hybrid", "lexical", "sqlite"]);
    assert.equal(canonicalBytes(report).includes("private query"), false);

    const driftPath = path.join(root, "drift.json");
    const drift = comparison();
    drift.adapters[0].topK = 5;
    await writeJson(driftPath, drift);
    await assert.rejects(async () => buildRetrievalReport({ missesPath, comparisonPath: driftPath }), /retrieval 비교 조건 불일치/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI writes byte-stable no-change JSON and Markdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retrieval-report-"));
  try {
    const missesPath = path.join(root, "misses.json");
    await writeJson(missesPath, missLock());
    const jsonOut = path.join(root, "report.json");
    const markdownOut = path.join(root, "report.md");
    const comparisonPath = path.join(root, "missing.json");
    const result = spawnSync(process.execPath, [REPORT_CLI, "--misses", missesPath, "--comparison", comparisonPath, "--json-out", jsonOut, "--markdown-out", markdownOut], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const resultAgain = spawnSync(
      process.execPath,
      [REPORT_CLI, "--misses", missesPath, "--comparison", comparisonPath, "--json-out", `${jsonOut}.again`, "--markdown-out", `${markdownOut}.again`],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(resultAgain.status, 0, resultAgain.stderr);
    assert.equal(await readFile(jsonOut, "utf8"), await readFile(`${jsonOut}.again`, "utf8"));
    assert.equal(await readFile(markdownOut, "utf8"), await readFile(`${markdownOut}.again`, "utf8"));
    assert.match(await readFile(markdownOut, "utf8"), /NO_CHANGE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
