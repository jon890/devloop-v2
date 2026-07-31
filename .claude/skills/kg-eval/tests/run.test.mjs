import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(__dirname, "../scripts/run.mjs");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function node(id, label, key) {
  return { id, label, key: String(key), display: `${label} ${key}`, properties: {} };
}

function rel(id, type, startId, endId) {
  return { id, type, startId, endId, properties: {} };
}

function makeQuestion(index) {
  const task = 480 + index;
  const commentId = `comment-${task}-1`;
  return {
    id: `Q-${String(index).padStart(2, "0")}`,
    audience: index % 2 === 0 ? "human" : "ai",
    difficulty: `L${((index - 1) % 5) + 1}`,
    question: `질문 ${index}`,
    answerability: "answerable",
    sourceRefs: [
      { id: `task-${task}`, type: "post", task },
      { id: `comment-${task}-1`, type: "comment", task, commentId },
    ],
    graphChecks: [
      {
        anchor: `task-${task}`,
        depth: 1,
        requiredNodes: [`task-${task}`, `comment-${task}-1`],
        requiredRelationships: [{ type: "HAS_COMMENT", start: `task-${task}`, end: `comment-${task}-1` }],
      },
    ],
    requiredEvidence: [`comment-${task}-1`],
    supportingEvidence: [`task-${task}`],
    orderedEvents: [`comment-${task}-1`],
    expectedClaims: [`기대 주장 ${index}`],
    forbiddenClaims: [],
  };
}

function makeSuite() {
  return {
    schemaVersion: "kg-eval-suite/v1",
    project: "tc-ocr",
    flowId: "api-gateway-removal",
    title: "API Gateway 제거 흐름",
    sourceSnapshot: "fixture",
    questions: Array.from({ length: 12 }, (_, index) => makeQuestion(index + 1)),
  };
}

async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "kg-eval-run-"));
  const suitePath = path.join(root, "eval", "suites", "suite.json");
  const postsDir = path.join(root, "apps", "pipeline", "data", "raw", "tc-ocr", "posts");
  await mkdir(path.dirname(suitePath), { recursive: true });
  await mkdir(postsDir, { recursive: true });
  const suite = makeSuite();
  await writeJson(suitePath, suite);
  for (const question of suite.questions) {
    const task = question.sourceRefs[0].task;
    await writeJson(path.join(postsDir, `${task}.json`), {
      post: { id: `post-${task}`, number: task },
      comments: [{ id: `comment-${task}-1` }],
    });
  }
  return { root, suitePath, suite, outPath: path.join(root, "eval", "runs", "run.json") };
}

async function withWorkspace(callback) {
  const workspace = await makeWorkspace();
  try {
    await callback(workspace);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

function suiteHash(suitePath) {
  return createHash("sha256").update(readFileSync(suitePath)).digest("hex");
}

function sourceNodesFromQuery(question, idPrefix = "") {
  const task = question.sourceRefs[0].task;
  const commentId = question.sourceRefs[1].commentId;
  return [node(`${idPrefix}task-${task}`, "Task", task), node(`${idPrefix}comment-${commentId}`, "Comment", commentId)];
}

function orderedAnswer(question) {
  return `업무 ${question.sourceRefs[0].task} 이후 댓글 ${question.sourceRefs[1].commentId}에서 확인했습니다.`;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function graphServer(suite, options = {}) {
  const calls = [];
  return {
    calls,
    handler: async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/graph/stats") {
        response.writeHead(options.statsStatus ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(options.statsStatus ? { error: "down" } : { nodes: { Task: 12 }, relationships: { HAS_COMMENT: 12 } }));
        return;
      }
      if (url.pathname === "/api/graph/search") {
        const key = url.searchParams.get("q");
        const question = suite.questions.find((item) => item.sourceRefs.some((sourceRef) => String(sourceRef.task) === key || sourceRef.commentId === key));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(question ? sourceNodesFromQuery(question, options.searchIdPrefix ?? "") : []));
        return;
      }
      if (url.pathname.includes("/neighbors")) {
        const encodedId = url.pathname.split("/")[4] ?? "";
        const elementId = decodeURIComponent(encodedId);
        const task = elementId.match(/task-(\d+)/)?.[1];
        const question = suite.questions.find((item) => String(item.sourceRefs[0].task) === task) ?? suite.questions[0];
        const nodes = sourceNodesFromQuery(question, options.neighborIdPrefix ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ nodes, relationships: [rel(`rel-${calls.length}`, "HAS_COMMENT", nodes[0].id, nodes[1].id)] }));
        return;
      }
      if (url.pathname === "/api/query") {
        const body = JSON.parse(await readRequestBody(request));
        const question = suite.questions.find((item) => item.question === body.question) ?? suite.questions[0];
        const nodes = options.evidenceNodes ? options.evidenceNodes(question) : sourceNodesFromQuery(question, options.evidenceIdPrefix ?? "");
        const answer = typeof options.answer === "function" ? options.answer(question) : (options.answer ?? orderedAnswer(question));
        const relationships = nodes.length >= 2 ? [rel("ev-rel", "HAS_COMMENT", nodes[0].id, nodes[1].id)] : [];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ answer, evidence: { nodes, relationships }, cypher: "MATCH (n) RETURN n" }));
        return;
      }
      response.writeHead(404);
      response.end();
    },
  };
}

async function runCli(workspace, baseUrl, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [
      RUNNER,
      "--suite",
      workspace.suitePath,
      "--stage",
      "plan005-baseline",
      "--api-base-url",
      baseUrl,
      "--query-model",
      "gpt-5.6-terra",
      "--repeats",
      "2",
      "--out",
      workspace.outPath,
      ...extraArgs,
    ],
    { cwd: workspace.root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { status, stdout, stderr };
}

test("runs questions and repetitions serially", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite);
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      const queryCalls = server.calls.filter((call) => call === "POST /api/query");
      assert.equal(queryCalls.length, workspace.suite.questions.length * 2);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts.length, workspace.suite.questions.length * 2);
      assert.equal(run.attempts[0].deterministicChecks.failureBoundary, "NONE");
      assert.equal(run.attempts[0].deterministicChecks.order.status, "PASS");
    });
  });
});

test("does not query when graph stats preflight fails", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite, { statsStatus: 500 });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 1);
      assert.equal(server.calls.filter((call) => call === "POST /api/query").length, 0);
    });
  });
});

test("resumes and skips completed attempts from an existing file", async () => {
  await withWorkspace(async (workspace) => {
    await writeJson(workspace.outPath, {
      schemaVersion: "kg-eval-run/v1",
      suitePath: workspace.suitePath,
      suiteHash: suiteHash(workspace.suitePath),
      commit: "unknown",
      stage: "plan005-baseline",
      baseUrl: "PLACEHOLDER",
      declaredQueryModel: "gpt-5.6-terra",
      repetitions: 2,
      startedAt: new Date().toISOString(),
      attempts: [
        {
          questionId: "Q-01",
          attempt: 1,
          startedAt: new Date().toISOString(),
          latencyMs: 1,
          httpStatus: 200,
          answer: "기존",
          evidence: { nodes: [], relationships: [] },
          cypher: "RETURN 1",
          error: null,
        },
      ],
    });
    const server = graphServer(workspace.suite);
    await withServer(server.handler, async (baseUrl) => {
      const existing = JSON.parse(await readFile(workspace.outPath, "utf8"));
      existing.baseUrl = baseUrl;
      await writeJson(workspace.outPath, existing);
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts.length, workspace.suite.questions.length * 2);
      assert.equal(server.calls.filter((call) => call === "POST /api/query").length, workspace.suite.questions.length * 2 - 1);
    });
  });
});

test("rejects mismatched conditions and lock conflicts", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite);
    await withServer(server.handler, async (baseUrl) => {
      await writeJson(workspace.outPath, {
        schemaVersion: "kg-eval-run/v1",
        suitePath: workspace.suitePath,
        suiteHash: suiteHash(workspace.suitePath),
        commit: "unknown",
        stage: "other-stage",
        baseUrl,
        declaredQueryModel: "gpt-5.6-terra",
        repetitions: 2,
        startedAt: new Date().toISOString(),
        attempts: [],
      });
      const mismatch = await runCli(workspace, baseUrl);
      assert.equal(mismatch.status, 1);
      assert.match(mismatch.stderr, /conditions differ/);
      await rm(workspace.outPath, { force: true });
      await writeFile(`${workspace.outPath}.lock`, "busy\n");
      const locked = await runCli(workspace, baseUrl);
      assert.equal(locked.status, 1);
      assert.match(locked.stderr, /output is locked/);
    });
  });
});

test("matches evidence by label and key when element ids differ", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite, {
      searchIdPrefix: "search-",
      neighborIdPrefix: "neighbor-",
      evidenceIdPrefix: "evidence-",
    });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts[0].deterministicChecks.retrieval.status, "PASS");
      assert.deepEqual(run.attempts[0].deterministicChecks.retrieval.missingRequiredEvidence, []);
    });
  });
});

test("marks empty ordered events as not applicable", async () => {
  await withWorkspace(async (workspace) => {
    workspace.suite.questions[0].orderedEvents = [];
    await writeJson(workspace.suitePath, workspace.suite);
    const server = graphServer(workspace.suite);
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts[0].deterministicChecks.order.status, "NOT_APPLICABLE");
      assert.equal(run.attempts[0].deterministicChecks.failureBoundary, "NONE");
    });
  });
});

test("fails ordered events when answer reverses or misses sourceRef needles", async () => {
  await withWorkspace(async (workspace) => {
    workspace.suite.questions[0].orderedEvents = ["task-481", "comment-481-1"];
    workspace.suite.questions[1].orderedEvents = ["task-482", "comment-482-1"];
    await writeJson(workspace.suitePath, workspace.suite);
    const server = graphServer(workspace.suite, {
      answer: (question) => {
        if (question.id === "Q-01") return `댓글 ${question.sourceRefs[1].commentId} 이후 업무 ${question.sourceRefs[0].task}`;
        if (question.id === "Q-02") return `업무 ${question.sourceRefs[0].task}만 언급합니다.`;
        return orderedAnswer(question);
      },
    });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      const reversed = run.attempts.find((attempt) => attempt.questionId === "Q-01");
      const missing = run.attempts.find((attempt) => attempt.questionId === "Q-02");
      assert.equal(reversed.deterministicChecks.retrieval.status, "PASS");
      assert.equal(reversed.deterministicChecks.order.status, "FAIL");
      assert.equal(reversed.deterministicChecks.failureBoundary, "ANSWER");
      assert.deepEqual(reversed.deterministicChecks.failedAxes, ["G"]);
      assert.equal(missing.deterministicChecks.retrieval.status, "PASS");
      assert.equal(missing.deterministicChecks.order.status, "FAIL");
      assert.deepEqual(missing.deterministicChecks.order.missing, ["comment-482-1"]);
    });
  });
});

test("does not evaluate order when retrieval fails first", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite, {
      answer: (question) => orderedAnswer(question),
      evidenceNodes: (question) => [sourceNodesFromQuery(question)[0]],
    });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts[0].deterministicChecks.retrieval.status, "FAIL");
      assert.equal(run.attempts[0].deterministicChecks.order.status, "NOT_EVALUATED");
      assert.equal(run.attempts[0].deterministicChecks.failureBoundary, "RETRIEVAL");
    });
  });
});

test("writes valid JSON and removes lock after SIGINT", async () => {
  await withWorkspace(async (workspace) => {
    let queryCount = 0;
    let releaseSecondQuery;
    const server = graphServer(workspace.suite);
    const handler = async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/api/query") {
        await server.handler(request, response);
        return;
      }
      queryCount += 1;
      if (queryCount === 2) {
        await new Promise((resolve) => {
          releaseSecondQuery = resolve;
        });
      }
      await server.handler(request, response);
    };
    await withServer(handler, async (baseUrl) => {
      const child = spawn(
        process.execPath,
        [
          RUNNER,
          "--suite",
          workspace.suitePath,
          "--stage",
          "plan005-baseline",
          "--api-base-url",
          baseUrl,
          "--query-model",
          "gpt-5.6-terra",
          "--repeats",
          "3",
          "--out",
          workspace.outPath,
        ],
        { cwd: workspace.root, stdio: ["ignore", "pipe", "pipe"] },
      );
      while (queryCount < 2) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.kill("SIGINT");
      releaseSecondQuery();
      const exit = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
      assert.equal(exit, 130);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert(run.attempts.length >= 1);
      assert.equal(await readFile(`${workspace.outPath}.lock`, "utf8").then(() => "exists", () => "missing"), "missing");
    });
  });
});
