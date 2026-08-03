import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSuite } from "../scripts/validate-suite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.resolve(__dirname, "../scripts/validate-suite.mjs");

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeQuestion(index, overrides = {}) {
  const task = 480 + index;
  const base = {
    id: `Q-${String(index).padStart(2, "0")}`,
    audience: index % 2 === 0 ? "human" : "ai",
    difficulty: `L${((index - 1) % 5) + 1}`,
    question: `질문 ${index}`,
    answerability: "answerable",
    sourceRefs: [
      { id: `task-${task}`, type: "post", task },
      { id: `comment-${task}-1`, type: "comment", task, commentId: `comment-${task}-1` }
    ],
    graphChecks: [
      {
        anchor: `task-${task}`,
        depth: 1,
        requiredNodes: [`task-${task}`, `comment-${task}-1`],
        requiredRelationships: [{ type: "HAS_COMMENT", start: `task-${task}`, end: `comment-${task}-1` }]
      }
    ],
    requiredEvidence: [`comment-${task}-1`],
    supportingEvidence: [`task-${task}`],
    orderedEvents: [`comment-${task}-1`],
    expectedClaims: [`기대 주장 ${index}`],
    forbiddenClaims: []
  };
  return { ...base, ...overrides };
}

function makeSuite(overrides = {}) {
  return {
    schemaVersion: "kg-eval-suite/v1",
    project: "tc-ocr",
    flowId: "api-gateway-removal",
    title: "API Gateway 제거 흐름",
    sourceSnapshot: "fixture",
    questions: Array.from({ length: 12 }, (_, index) => makeQuestion(index + 1)),
    ...overrides
  };
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "kg-eval-suite-"));
  const dataRoot = path.join(root, "data");
  const suitePath = path.join(root, "suite.json");
  const postsDir = path.join(dataRoot, "raw", "tc-ocr", "posts");
  await mkdir(postsDir, { recursive: true });
  for (let index = 1; index <= 12; index += 1) {
    const task = 480 + index;
    await writeJson(path.join(postsDir, `${task}.json`), {
      post: { id: `post-${task}`, number: task },
      comments: [{ id: `comment-${task}-1` }]
    });
  }
  return { root, dataRoot, suitePath };
}

async function withFixture(callback) {
  const fixture = await makeFixture();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function validateObject(fixture, suite) {
  await writeJson(fixture.suitePath, suite);
  return validateSuite(fixture.suitePath, fixture.dataRoot);
}

test("accepts a valid source-backed suite", async () => {
  await withFixture(async (fixture) => {
    const errors = await validateObject(fixture, makeSuite());
    assert.deepEqual(errors, []);
  });
});

test("rejects unsupported suite schemaVersion", async () => {
  await withFixture(async (fixture) => {
    const errors = await validateObject(fixture, makeSuite({ schemaVersion: "kg-eval-suite/v999" }));
    assert(errors.some((error) => error === "schemaVersion: must be kg-eval-suite/v1"));

    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [VALIDATOR, "--suite", fixture.suitePath, "--data-root", fixture.dataRoot], {
      encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /schemaVersion: must be kg-eval-suite\/v1/);
  });
});

test("accepts insufficient-source negative controls with empty graph checks", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, {
      answerability: "insufficient-source",
      graphChecks: [],
      requiredEvidence: [],
      forbiddenClaims: ["원천에 없는 인과 주장"]
    });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert.deepEqual(errors, []);
  });
});

test("rejects duplicate ids, missing audience coverage, and missing difficulty coverage", async () => {
  await withFixture(async (fixture) => {
    const suite = makeSuite({
      questions: Array.from({ length: 12 }, (_, index) =>
        makeQuestion(index + 1, {
          id: index === 1 ? "Q-01" : `Q-${String(index + 1).padStart(2, "0")}`,
          audience: "human",
          difficulty: "L1"
        })
      )
    });
    const errors = await validateObject(fixture, suite);
    assert(errors.some((error) => error.includes("Q-01 id: must be unique")));
    assert(errors.some((error) => error.includes("must include audience=ai")));
    assert(errors.some((error) => error.includes("must include difficulty=L2")));
  });
});

test("rejects invalid enumerations and too few questions", async () => {
  await withFixture(async (fixture) => {
    const suite = makeSuite({ questions: [makeQuestion(1, { audience: "bot", difficulty: "L6", answerability: "maybe" })] });
    const errors = await validateObject(fixture, suite);
    assert(errors.some((error) => error.includes("questions: must contain at least 12 questions")));
    assert(errors.some((error) => error.includes("audience: must be human or ai")));
    assert(errors.some((error) => error.includes("difficulty: must be L1")));
    assert(errors.some((error) => error.includes("answerability: must be answerable")));
  });
});

test("rejects answerable questions without source refs or required evidence", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, { sourceRefs: [], graphChecks: [], requiredEvidence: [] });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert(errors.some((error) => error.includes("sourceRefs: answerable questions require at least one sourceRef")));
    assert(errors.some((error) => error.includes("requiredEvidence: answerable questions require at least one requiredEvidence item")));
    assert(errors.some((error) => error.includes("graphChecks: answerable questions require at least one graphCheck")));
  });
});

test("rejects insufficient-source questions with required evidence or no forbidden claims", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, { answerability: "insufficient-source", forbiddenClaims: [] });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert(errors.some((error) => error.includes("requiredEvidence: insufficient-source questions must not declare requiredEvidence")));
    assert(errors.some((error) => error.includes("forbiddenClaims: insufficient-source questions require at least one forbiddenClaim")));
  });
});

test("rejects source refs that do not exist in raw post data", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, {
      sourceRefs: [{ id: "missing-comment", type: "comment", task: 481, commentId: "missing-comment" }],
      requiredEvidence: ["missing-comment"],
      supportingEvidence: [],
      orderedEvents: []
    });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert(errors.some((error) => error.includes("Q-01 sourceRefs[0].commentId: does not exist in comments[].id")));
  });
});

test("rejects source ref aliases, task type, non-integer task, and unexpected fields", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, {
      sourceRefs: [
        { id: "alias-task", type: "task", taskNumber: 481, number: 481, kind: "post", extra: "nope" },
        { id: "string-task", type: "post", task: "481" }
      ],
      requiredEvidence: ["alias-task"],
      supportingEvidence: [],
      orderedEvents: [],
      graphChecks: [
        {
          anchor: "alias-task",
          depth: 1,
          requiredNodes: ["alias-task"],
          requiredRelationships: []
        }
      ]
    });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert(errors.some((error) => error.includes("sourceRefs[0].type: must be post or comment")));
    assert(errors.some((error) => error.includes("sourceRefs[0].taskNumber: unexpected field")));
    assert(errors.some((error) => error.includes("sourceRefs[0].number: unexpected field")));
    assert(errors.some((error) => error.includes("sourceRefs[0].kind: unexpected field")));
    assert(errors.some((error) => error.includes("sourceRefs[0].extra: unexpected field")));
    assert(errors.some((error) => error.includes("sourceRefs[0].task: required integer task number")));
    assert(errors.some((error) => error.includes("sourceRefs[1].task: required integer task number")));
  });
});

test("rejects evidence and ordered events that are not sourceRef id string arrays", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, {
      requiredEvidence: [{ sourceRef: "not-declared" }],
      supportingEvidence: ["also-not-declared"],
      orderedEvents: [{ sourceRefs: ["comment-481-1", "missing-event"] }]
    });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert(errors.some((error) => error.includes("requiredEvidence[0]: must be a non-empty sourceRef id string")));
    assert(errors.some((error) => error.includes("supportingEvidence[0]: references undeclared sourceRef: also-not-declared")));
    assert(errors.some((error) => error.includes("orderedEvents[0]: must be a non-empty sourceRef id string")));
  });
});

test("rejects graph checks with invalid references, depth, relationships, and fields", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, {
      graphChecks: [
        {
          anchor: "not-declared",
          depth: 6,
          requiredNodes: ["comment-481-1", "missing-node"],
          requiredRelationships: [{ type: "", start: "task-481", end: "missing-end", extra: true }],
          extra: "nope"
        }
      ]
    });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert(errors.some((error) => error.includes("graphChecks[0].extra: unexpected field")));
    assert(errors.some((error) => error.includes("graphChecks[0].anchor: references undeclared sourceRef: not-declared")));
    assert(errors.some((error) => error.includes("graphChecks[0].depth: must be an integer from 1 to 5")));
    assert(errors.some((error) => error.includes("graphChecks[0].requiredNodes[1]: references undeclared sourceRef: missing-node")));
    assert(errors.some((error) => error.includes("graphChecks[0].requiredRelationships[0].extra: unexpected field")));
    assert(errors.some((error) => error.includes("graphChecks[0].requiredRelationships[0].type: required non-empty string")));
    assert(errors.some((error) => error.includes("graphChecks[0].requiredRelationships[0].end: references undeclared sourceRef: missing-end")));
  });
});

test("rejects empty expected claims and invalid forbidden claim items", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, { expectedClaims: [], forbiddenClaims: ["", 123] });
    const errors = await validateObject(fixture, makeSuite({ questions }));
    assert(errors.some((error) => error.includes("expectedClaims: must contain at least one item")));
    assert(errors.some((error) => error.includes("forbiddenClaims[0]: must be a non-empty string")));
    assert(errors.some((error) => error.includes("forbiddenClaims[1]: must be a non-empty string")));
  });
});

test("prints question id and field path to stderr on validation failure", async () => {
  await withFixture(async (fixture) => {
    const questions = makeSuite().questions;
    questions[0] = makeQuestion(1, { requiredEvidence: ["not-declared"] });
    await writeJson(fixture.suitePath, makeSuite({ questions }));
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [VALIDATOR, "--suite", fixture.suitePath, "--data-root", fixture.dataRoot], {
      encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Q-01 requiredEvidence\[0\]: references undeclared sourceRef: not-declared/);
  });
});
