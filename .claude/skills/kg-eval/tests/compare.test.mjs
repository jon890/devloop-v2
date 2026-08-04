import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareSummaries } from "../scripts/compare.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPARER = path.resolve(__dirname, "../scripts/compare.mjs");

function summary(overrides = {}) {
  return {
    schemaVersion: "kg-eval-report/v1",
    suite: {
      hash: "hash-a",
      path: "eval/suites/tc-ocr-api-gateway.json",
    },
    questions: [
      { id: "Q-01", finalVerdict: "FAIL", failureBoundary: "RETRIEVAL", failedAxes: ["R"] },
      { id: "Q-02", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
      { id: "Q-03", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
      { id: "Q-04", finalVerdict: "REVIEW", failureBoundary: "ANSWER", failedAxes: ["P"] },
      { id: "Q-05", finalVerdict: "FAIL", failureBoundary: "RETRIEVAL", failedAxes: ["R"] },
    ],
    ...overrides,
  };
}

test("classifies regressions, improvements, unchanged, review, and boundary changes", () => {
  const result = compareSummaries(
    summary(),
    summary({
      questions: [
        { id: "Q-01", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
        { id: "Q-02", finalVerdict: "FAIL", failureBoundary: "GRAPH", failedAxes: ["G"] },
        { id: "Q-03", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
        { id: "Q-04", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
        { id: "Q-05", finalVerdict: "FAIL", failureBoundary: "RETRIEVAL", failedAxes: ["P"] },
      ],
    }),
  );
  assert.deepEqual(result.improved, ["Q-01"]);
  assert.deepEqual(result.regressed, ["Q-02"]);
  assert.deepEqual(result.unchanged, ["Q-03", "Q-05"]);
  assert.deepEqual(result.review, ["Q-04"]);
  assert.deepEqual(
    result.axisChanges.find((change) => change.id === "Q-05"),
    { id: "Q-05", resolved: ["R"], added: ["P"] },
  );
  assert(result.failureBoundaryChanges.some((change) => change.id === "Q-01" && change.from === "RETRIEVAL" && change.to === "NONE"));
  assert(result.failureBoundaryChanges.some((change) => change.id === "Q-02" && change.axes.added.includes("G")));
  assert(!result.failureBoundaryChanges.some((change) => change.id === "Q-05"));
});

// 세트는 시간이 지나며 자란다. 해시가 다르다고 거부하면 문항을 더할 때마다 비교선이 끊긴다.
test("세트 해시가 달라도 문항 id 교집합으로 비교하고 해시 변경을 표시한다", () => {
  const result = compareSummaries(summary(), summary({ suite: { hash: "hash-b" } }));
  assert.equal(result.suiteChanged, true);
  assert.equal(result.baselineSuiteHash, "hash-a");
  assert.equal(result.candidateSuiteHash, "hash-b");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
});

test("후보에만 있는 문항은 added 로, 기준선에만 있는 문항은 removed 로 나눈다", () => {
  const before = summary({ questions: [{ id: "Q-01", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] }] });
  const after = summary({
    suite: { hash: "hash-b" },
    questions: [
      { id: "Q-01", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
      { id: "Q-NEW", finalVerdict: "FAIL", failureBoundary: "RETRIEVAL", failedAxes: ["R"] },
    ],
  });
  const result = compareSummaries(before, after);
  assert.deepEqual(result.added, ["Q-NEW"]);
  assert.deepEqual(result.unchanged, ["Q-01"]);
  assert.deepEqual(result.review, []);
});

test("같은 문항의 gold 규모가 바뀌면 개선·회귀가 아니라 criteriaChanged 다", () => {
  const before = summary({
    questions: [{ id: "Q-01", requiredEvidenceCount: 5, finalVerdict: "FAIL", failureBoundary: "RETRIEVAL", failedAxes: ["R"] }],
  });
  const after = summary({
    suite: { hash: "hash-b" },
    questions: [{ id: "Q-01", requiredEvidenceCount: 4, finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] }],
  });
  const result = compareSummaries(before, after);
  assert.deepEqual(result.criteriaChanged, ["Q-01"]);
  assert.deepEqual(result.improved, [], "기준이 바뀐 문항을 개선으로 세지 않는다");
  assert.deepEqual(result.axisChanges, []);
});

test("rejects missing and conflicting suite hashes", () => {
  assert.throws(() => compareSummaries(summary({ suite: undefined }), summary()), /baseline suiteHash is missing/);
  assert.throws(() => compareSummaries(summary(), summary({ suite: undefined })), /candidate suiteHash is missing/);
  assert.throws(() => compareSummaries(summary({ suiteHash: "hash-a", suite: { hash: "hash-b" } }), summary()), /conflicting suite hashes/);
});

test("accepts raw top-level suiteHash and report nested suite hash", () => {
  const result = compareSummaries(
    { suiteHash: "hash-a", questions: [{ id: "Q-01", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] }] },
    { suite: { hash: "hash-a" }, questions: [{ id: "Q-01", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] }] },
  );
  assert.equal(result.baselineSuiteHash, "hash-a");
  assert.equal(result.suiteChanged, false);
  assert.deepEqual(result.unchanged, ["Q-01"]);
});

test("후보에서 사라진 문항은 removed 로 빼고 축 변화로 세지 않는다", () => {
  const result = compareSummaries(
    summary({
      questions: [{ id: "Q-01", finalVerdict: "FAIL", failureBoundary: "RETRIEVAL", failedAxes: ["R"] }],
    }),
    summary({
      questions: [],
    }),
  );
  assert.deepEqual(result.removed, ["Q-01"]);
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.axisChanges, []);
  assert.deepEqual(result.failureBoundaryChanges, []);
});

test("해시가 달라도 0 으로 끝나고 suiteChanged 를 출력한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kg-eval-compare-"));
  try {
    const baseline = path.join(root, "baseline.json");
    const candidate = path.join(root, "candidate.json");
    await writeFile(baseline, `${JSON.stringify(summary())}\n`);
    await writeFile(candidate, `${JSON.stringify(summary({ suite: { hash: "hash-b" } }))}\n`);
    const grown = spawnSync(process.execPath, [COMPARER, "--baseline", baseline, "--candidate", candidate], { encoding: "utf8" });
    assert.equal(grown.status, 0, grown.stderr);
    assert.equal(JSON.parse(grown.stdout).suiteChanged, true);
    await writeFile(candidate, `${JSON.stringify(summary())}\n`);
    const accepted = spawnSync(process.execPath, [COMPARER, "--baseline", baseline, "--candidate", candidate], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout).unchanged, ["Q-01", "Q-02", "Q-03", "Q-05"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
