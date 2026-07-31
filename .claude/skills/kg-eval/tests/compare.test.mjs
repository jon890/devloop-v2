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
    suiteHash: "hash-a",
    questions: [
      { id: "Q-01", finalVerdict: "FAIL", failureBoundary: "RETRIEVAL", failedAxes: ["R"] },
      { id: "Q-02", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
      { id: "Q-03", finalVerdict: "PASS", failureBoundary: "NONE", failedAxes: [] },
      { id: "Q-04", finalVerdict: "REVIEW", failureBoundary: "ANSWER", failedAxes: ["P"] },
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
      ],
    }),
  );
  assert.deepEqual(result.improved, ["Q-01"]);
  assert.deepEqual(result.regressed, ["Q-02"]);
  assert.deepEqual(result.unchanged, ["Q-03"]);
  assert.deepEqual(result.review, ["Q-04"]);
  assert(result.failureBoundaryChanges.some((change) => change.id === "Q-01" && change.from === "RETRIEVAL" && change.to === "NONE"));
  assert(result.failureBoundaryChanges.some((change) => change.id === "Q-02" && change.axes.added.includes("G")));
});

test("rejects comparison when suite hashes differ", () => {
  assert.throws(() => compareSummaries(summary(), summary({ suiteHash: "hash-b" })), /suiteHash differs/);
});

test("prints JSON result and exits nonzero on hash mismatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kg-eval-compare-"));
  try {
    const baseline = path.join(root, "baseline.json");
    const candidate = path.join(root, "candidate.json");
    await writeFile(baseline, `${JSON.stringify(summary())}\n`);
    await writeFile(candidate, `${JSON.stringify(summary({ suiteHash: "hash-b" }))}\n`);
    const rejected = spawnSync(process.execPath, [COMPARER, "--baseline", baseline, "--candidate", candidate], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /suiteHash differs/);
    await writeFile(candidate, `${JSON.stringify(summary())}\n`);
    const accepted = spawnSync(process.execPath, [COMPARER, "--baseline", baseline, "--candidate", candidate], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout).unchanged, ["Q-01", "Q-02", "Q-03"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
