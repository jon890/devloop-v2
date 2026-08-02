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

function defaultSamplesByLabel(suite, idPrefix = "") {
  const samples = { Task: [], Comment: [] };
  for (const question of suite.questions) {
    const [taskNode, commentNode] = sourceNodesFromQuery(question, idPrefix);
    samples.Task.push(taskNode);
    samples.Comment.push(commentNode);
  }
  return samples;
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

function waitForExit(child, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function graphServer(suite, options = {}) {
  const calls = [];
  const samplesByLabel = options.samplesByLabel ?? defaultSamplesByLabel(suite, options.sampleIdPrefix ?? "");
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
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([]));
        return;
      }
      if (url.pathname === "/api/graph/samples") {
        const label = url.searchParams.get("label");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "5");
        if (typeof options.samplesResponse === "function") {
          const value = options.samplesResponse({ label, offset, limit, calls });
          response.writeHead(value.status ?? 200, { "content-type": "application/json" });
          response.end(JSON.stringify(value.body));
          return;
        }
        const nodes = samplesByLabel[label] ?? [];
        response.writeHead(options.samplesStatus ?? 200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            options.samplesBody ??
              {
                nodes: nodes.slice(offset, offset + limit),
                relationships: [],
                total: nodes.length,
                offset,
                limit,
              },
          ),
        );
        return;
      }
      if (url.pathname.includes("/neighbors")) {
        const encodedId = url.pathname.split("/")[4] ?? "";
        const elementId = decodeURIComponent(encodedId);
        const task = elementId.match(/task-(\d+)/)?.[1];
        const commentId = elementId.match(/comment-(comment-\d+-1)/)?.[1];
        const question =
          suite.questions.find((item) => String(item.sourceRefs[0].task) === task || item.sourceRefs[1].commentId === commentId) ??
          suite.questions[0];
        const nodes = sourceNodesFromQuery(question, options.neighborIdPrefix ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ nodes, relationships: [rel(`rel-${calls.length}`, "HAS_COMMENT", nodes[0].id, nodes[1].id)] }));
        return;
      }
      if (url.pathname === "/api/query") {
        const body = JSON.parse(await readRequestBody(request));
        const question = suite.questions.find((item) => item.question === body.question) ?? suite.questions[0];
        if (typeof options.queryResponse === "function") {
          const value = options.queryResponse({ question, calls });
          response.writeHead(value.status ?? 200, { "content-type": "application/json" });
          response.end(JSON.stringify(value.body));
          return;
        }
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

async function runCli(workspace, baseUrl, extraArgs = [], repeats = "2") {
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
      repeats,
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
      assert.equal(server.calls.filter((call) => call === "GET /api/graph/search").length, 0);
      assert.equal(server.calls.filter((call) => call === "GET /api/graph/samples").length, 1);
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

test("replaces a failed attempt on resume without duplicating attempt keys", async () => {
  await withWorkspace(async (workspace) => {
    const failedRecord = {
      questionId: "Q-01",
      attempt: 1,
      startedAt: new Date().toISOString(),
      latencyMs: 1,
      httpStatus: 500,
      answer: "",
      evidence: { nodes: [], relationships: [] },
      cypher: null,
      error: "{\"error\":\"transient\"}",
    };
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
        failedRecord,
        {
          questionId: "Q-01",
          attempt: 2,
          startedAt: new Date().toISOString(),
          latencyMs: 1,
          httpStatus: 200,
          answer: "완료",
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
      const keys = run.attempts.map((attempt) => `${attempt.questionId}:${attempt.attempt}`);
      assert.equal(new Set(keys).size, keys.length);
      const retried = run.attempts.filter((attempt) => attempt.questionId === "Q-01" && attempt.attempt === 1);
      assert.equal(retried.length, 1);
      assert.equal(retried[0].error, null);
      assert.equal(retried[0].httpStatus, 200);
      assert.equal(run.attempts.filter((attempt) => attempt.questionId === "Q-01" && attempt.attempt === 2).length, 1);
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

test("resolves comment anchors through graph samples and caches each label for the run", async () => {
  await withWorkspace(async (workspace) => {
    workspace.suite.questions[0].graphChecks[0].anchor = "comment-481-1";
    await writeJson(workspace.suitePath, workspace.suite);
    const server = graphServer(workspace.suite);
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(server.calls.filter((call) => call === "GET /api/graph/samples").length, 2);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts[0].deterministicChecks.graph.status, "PASS");
    });
  });
});

test("matches evidence by label and key when element ids differ", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite, {
      sampleIdPrefix: "sample-",
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

test("paginates graph samples and requires exact sourceRef identity", async () => {
  await withWorkspace(async (workspace) => {
    const noisyTasks = Array.from({ length: 100 }, (_, index) => node(`noise-task-${index}`, "Task", `noise-${index}`));
    const samplesByLabel = {
      Task: [...noisyTasks, ...defaultSamplesByLabel(workspace.suite).Task],
      Comment: defaultSamplesByLabel(workspace.suite).Comment,
    };
    const server = graphServer(workspace.suite, { samplesByLabel });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      const sampleCalls = server.calls.filter((call) => call === "GET /api/graph/samples");
      assert.equal(sampleCalls.length, 2);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts[0].deterministicChecks.graph.status, "PASS");
    });
  });
});

test("records graph failure when sourceRef identity is missing from graph samples", async () => {
  await withWorkspace(async (workspace) => {
    const samplesByLabel = {
      Task: defaultSamplesByLabel(workspace.suite).Task.filter((sample) => sample.key !== "481"),
      Comment: defaultSamplesByLabel(workspace.suite).Comment,
    };
    const server = graphServer(workspace.suite, { samplesByLabel });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(server.calls.filter((call) => call === "POST /api/query").length, (workspace.suite.questions.length - 1) * 2);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      const missing = run.attempts.find((attempt) => attempt.questionId === "Q-01");
      assert.equal(missing.deterministicChecks.graph.status, "FAIL");
      assert.equal(missing.deterministicChecks.failureBoundary, "GRAPH");
      assert.deepEqual(missing.deterministicChecks.failedAxes, ["G"]);
    });
  });
});

test("records graph failure when graph samples response violates contract", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite, { samplesBody: { nodes: [], relationships: [], total: "12", offset: 0, limit: 100 } });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(server.calls.filter((call) => call === "POST /api/query").length, 0);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts[0].deterministicChecks.graph.status, "FAIL");
      assert.match(run.attempts[0].deterministicChecks.graph.checks[0].reason, /samples Task HTTP 200/);
    });
  });
});

test("does not poison label cache with transient graph samples failures", async () => {
  await withWorkspace(async (workspace) => {
    let taskSamplesCalls = 0;
    const defaultSamples = defaultSamplesByLabel(workspace.suite);
    const server = graphServer(workspace.suite, {
      samplesResponse: ({ label, offset, limit }) => {
        const nodes = defaultSamples[label] ?? [];
        if (label === "Task") {
          taskSamplesCalls += 1;
          if (taskSamplesCalls === 1) {
            return { status: 500, body: { error: "transient" } };
          }
        }
        return { body: { nodes: nodes.slice(offset, offset + limit), relationships: [], total: nodes.length, offset, limit } };
      },
    });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(taskSamplesCalls, 2);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      const first = run.attempts.find((attempt) => attempt.questionId === "Q-01" && attempt.attempt === 1);
      const second = run.attempts.find((attempt) => attempt.questionId === "Q-01" && attempt.attempt === 2);
      assert.equal(first.deterministicChecks.graph.status, "FAIL");
      assert.match(first.deterministicChecks.graph.checks[0].reason, /samples Task HTTP 500/);
      assert.equal(second.deterministicChecks.graph.status, "PASS");
      assert.equal(second.deterministicChecks.failureBoundary, "NONE");
    });
  });
});

test("records graph failure when graph samples pagination stalls", async () => {
  await withWorkspace(async (workspace) => {
    const server = graphServer(workspace.suite, { samplesBody: { nodes: [], relationships: [], total: 12, offset: 0, limit: 100 } });
    await withServer(server.handler, async (baseUrl) => {
      const result = await runCli(workspace, baseUrl);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(server.calls.filter((call) => call === "POST /api/query").length, 0);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts[0].deterministicChecks.graph.status, "FAIL");
      assert.match(run.attempts[0].deterministicChecks.graph.checks[0].reason, /pagination did not advance/);
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

test("SIGINT aborts in-flight query, preserves completed attempts, and resumes without duplicates", async () => {
  await withWorkspace(async (workspace) => {
    let queryCount = 0;
    let releasePendingQuery;
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
          releasePendingQuery = resolve;
        });
        if (request.destroyed || response.destroyed) {
          return;
        }
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
      const exit = await waitForExit(child, 1000);
      assert.equal(exit, 130);
      const run = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(run.attempts.length, 1);
      assert.equal(run.attempts[0].questionId, "Q-01");
      assert.equal(run.attempts[0].attempt, 1);
      assert.equal(run.attempts.filter((attempt) => attempt.questionId === "Q-01" && attempt.attempt === 2).length, 0);
      assert.equal(typeof run.interruptedAt, "string");
      assert.equal(await readFile(`${workspace.outPath}.lock`, "utf8").then(() => "exists", () => "missing"), "missing");
      releasePendingQuery();

      const resumed = await runCli(workspace, baseUrl, [], "3");
      assert.equal(resumed.status, 0, resumed.stderr);
      const resumedRun = JSON.parse(await readFile(workspace.outPath, "utf8"));
      assert.equal(resumedRun.attempts.length, workspace.suite.questions.length * 3);
      assert.equal(resumedRun.attempts.filter((attempt) => attempt.questionId === "Q-01" && attempt.attempt === 1).length, 1);
      assert.equal(resumedRun.attempts.filter((attempt) => attempt.questionId === "Q-01" && attempt.attempt === 2).length, 1);
    });
  });
});
