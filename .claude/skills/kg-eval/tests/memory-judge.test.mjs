import assert from "node:assert/strict";
import test from "node:test";
import { changedPathsFromDiff, isAllowedPath, judgeMemoryAttempt } from "../scripts/memory/judge.mjs";

test("passes when validation succeeds and changes stay inside allowed paths", () => {
  const result = judgeMemoryAttempt({
    validationResult: { status: 0 },
    allowedPaths: ["src/", "package.json"],
    diff: {
      changedPaths: ["src/service.js", "package.json"],
    },
    events: [{ type: "agent-started" }],
  });
  assert.deepEqual(result, {
    taskSuccess: true,
    wrongEditCount: 0,
    wrongEditPaths: [],
    reworkCount: 0,
  });
});

test("separates validation failure, wrong edit count, and rework count", () => {
  const patch = [
    "diff --git a/src/service.js b/src/service.js",
    "index 1111111..2222222 100644",
    "--- a/src/service.js",
    "+++ b/src/service.js",
    "diff --git a/docs/private.md b/docs/private.md",
    "index 1111111..2222222 100644",
    "--- a/docs/private.md",
    "+++ b/docs/private.md",
  ].join("\n");
  const result = judgeMemoryAttempt({
    validationResult: { status: 1 },
    allowedPaths: ["src/"],
    diff: { patch },
    events: [{ type: "validation-failed" }, { type: "rework" }, { type: "note" }],
  });
  assert.equal(result.taskSuccess, false);
  assert.equal(result.wrongEditCount, 1);
  assert.deepEqual(result.wrongEditPaths, ["docs/private.md"]);
  assert.equal(result.reworkCount, 2);
});

test("parses git diff paths and matches directory boundaries", () => {
  assert.deepEqual(
    changedPathsFromDiff("diff --git a/src/a.js b/src/a.js\ndiff --git a/src-old/b.js b/src-old/b.js\n"),
    ["src/a.js", "src-old/b.js"],
  );
  assert.equal(isAllowedPath("src/a.js", ["src/"]), true);
  assert.equal(isAllowedPath("src-old/b.js", ["src/"]), false);
  assert.equal(isAllowedPath("package.json", ["package.json"]), true);
});
