#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { validateSuite } from "./validate-suite.mjs";

const RUN_SCHEMA_VERSION = "kg-eval-run/v1";
const DEFAULT_REPETITIONS = 3;
const DATA_ROOT = "apps/pipeline/data";
const GRAPH_SAMPLE_PAGE_SIZE = 100;

function parseArgs(argv) {
  const args = {};
  const valueArgs = new Set(["--suite", "--stage", "--api-base-url", "--query-model", "--repeats", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!valueArgs.has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    args[arg.slice(2)] = value;
    index += 1;
  }
  for (const required of ["suite", "stage", "api-base-url", "query-model", "out"]) {
    if (!args[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  const repetitions = args.repeats === undefined ? DEFAULT_REPETITIONS : Number(args.repeats);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error("--repeats must be a positive integer");
  }
  return {
    suitePath: args.suite,
    stage: args.stage,
    baseUrl: args["api-base-url"].replace(/\/+$/, ""),
    declaredQueryModel: args["query-model"],
    repetitions,
    outPath: args.out,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmpPath, filePath);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) {
    return "unknown";
  }
  return result.stdout.trim();
}

async function acquireLock(outPath) {
  const lockPath = `${outPath}.lock`;
  await mkdir(path.dirname(outPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    await handle.writeFile(`${process.pid}\n`);
    return { lockPath, handle };
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`output is locked: ${lockPath}`);
    }
    throw error;
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  await lock.handle?.close();
  await rm(lock.lockPath, { force: true });
}

function sourceRefIdentity(sourceRef) {
  if (sourceRef.type === "post") {
    return { label: "Task", key: String(sourceRef.task) };
  }
  if (sourceRef.type === "comment") {
    return { label: "Comment", key: String(sourceRef.commentId) };
  }
  throw new Error(`unsupported sourceRef type: ${sourceRef.type}`);
}

function sourceRefIndex(question) {
  return new Map(question.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRefIdentity(sourceRef)]));
}

function nodeIdentity(node) {
  return `${node?.label}:${String(node?.key)}`;
}

function sameIdentity(node, identity) {
  return node?.label === identity.label && String(node?.key) === String(identity.key);
}

function attemptKey(attempt) {
  return `${attempt.questionId}:${attempt.attempt}`;
}

function hasEvidenceShape(value) {
  return value && Array.isArray(value.nodes) && Array.isArray(value.relationships);
}

function isSafePagination(value) {
  return (
    Number.isSafeInteger(value?.total) &&
    value.total >= 0 &&
    Number.isSafeInteger(value?.offset) &&
    value.offset >= 0 &&
    Number.isInteger(value?.limit) &&
    value.limit >= 1 &&
    value.limit <= GRAPH_SAMPLE_PAGE_SIZE
  );
}

function hasGraphSamplesShape(value) {
  return hasEvidenceShape(value) && isSafePagination(value);
}

function isNonnegativeNumberRecord(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => Number.isInteger(item) && item >= 0)
  );
}

function hasGraphStatsShape(value) {
  return value && isNonnegativeNumberRecord(value.nodes) && isNonnegativeNumberRecord(value.relationships);
}

function hasQueryResponseShape(value) {
  return value && typeof value.answer === "string" && hasEvidenceShape(value.evidence) && typeof value.cypher === "string";
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

async function requestJson(url, options = {}) {
  const started = Date.now();
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, latencyMs: Date.now() - started };
}

async function assertPreflight({ suitePath, baseUrl }) {
  const suiteErrors = await validateSuite(suitePath, DATA_ROOT);
  if (suiteErrors.length > 0) {
    throw new Error(`suite validation failed:\n${suiteErrors.join("\n")}`);
  }
  const stats = await requestJson(`${baseUrl}/api/graph/stats`);
  if (stats.status < 200 || stats.status >= 300 || !hasGraphStatsShape(stats.body)) {
    throw new Error(`graph stats preflight failed: HTTP ${stats.status}`);
  }
}

async function loadSamplesByLabel(baseUrl, label, labelCache, signal) {
  const cached = labelCache.get(label);
  if (cached) return cached;

  const nodes = [];
  let offset = 0;
  while (true) {
    const samples = await requestJson(
      `${baseUrl}/api/graph/samples?label=${encodeURIComponent(label)}&offset=${offset}&limit=${GRAPH_SAMPLE_PAGE_SIZE}`,
      { signal },
    );
    if (samples.status < 200 || samples.status >= 300 || !hasGraphSamplesShape(samples.body)) {
      return { ok: false, label, nodes: [], reason: `samples ${label} HTTP ${samples.status}` };
    }
    if (samples.body.offset !== offset || samples.body.limit !== GRAPH_SAMPLE_PAGE_SIZE) {
      return { ok: false, label, nodes: [], reason: `samples ${label} pagination contract mismatch` };
    }
    nodes.push(...samples.body.nodes);
    const nextOffset = offset + samples.body.nodes.length;
    if (samples.body.nodes.length === 0 && nextOffset < samples.body.total) {
      return { ok: false, label, nodes: [], reason: `samples ${label} pagination did not advance` };
    }
    if (nextOffset >= samples.body.total) {
      const result = { ok: true, label, nodes };
      labelCache.set(label, result);
      return result;
    }
    offset = nextOffset;
  }
}

async function resolveSourceRef(baseUrl, sourceRefId, identities, labelCache, signal) {
  const identity = identities.get(sourceRefId);
  if (!identity) {
    return { ok: false, sourceRefId, reason: "undeclared sourceRef" };
  }
  const samples = await loadSamplesByLabel(baseUrl, identity.label, labelCache, signal);
  if (!samples.ok) {
    return { ok: false, sourceRefId, identity, reason: samples.reason };
  }
  const node = samples.nodes.find((candidate) => sameIdentity(candidate, identity));
  const result = node ? { ok: true, sourceRefId, identity, node } : { ok: false, sourceRefId, identity, reason: "not found by label/key" };
  return result;
}

async function evaluateGraphChecks(baseUrl, question, labelCache = new Map(), signal) {
  const identities = sourceRefIndex(question);
  const checks = [];
  for (const check of question.graphChecks ?? []) {
    const anchor = await resolveSourceRef(baseUrl, check.anchor, identities, labelCache, signal);
    if (!anchor.ok) {
      checks.push({ anchor: check.anchor, status: "FAIL", missingNodes: [check.anchor], missingRelationships: [], reason: anchor.reason });
      continue;
    }

    const neighbors = await requestJson(`${baseUrl}/api/graph/nodes/${encodeURIComponent(anchor.node.id)}/neighbors?depth=${check.depth}`, { signal });
    if (neighbors.status < 200 || neighbors.status >= 300 || !hasEvidenceShape(neighbors.body)) {
      checks.push({ anchor: check.anchor, status: "FAIL", missingNodes: [], missingRelationships: [], reason: `neighbors HTTP ${neighbors.status}` });
      continue;
    }

    const nodes = neighbors.body.nodes;
    const nodesByElementId = new Map(nodes.map((node) => [node.id, node]));
    const identitySet = new Set(nodes.map(nodeIdentity));
    const missingNodes = (check.requiredNodes ?? []).filter((sourceRefId) => {
      const identity = identities.get(sourceRefId);
      return !identity || !identitySet.has(`${identity.label}:${identity.key}`);
    });
    const missingRelationships = (check.requiredRelationships ?? []).filter((relationship) =>
      !neighbors.body.relationships.some((candidate) => {
        const start = nodesByElementId.get(candidate.startId);
        const end = nodesByElementId.get(candidate.endId);
        const startIdentity = identities.get(relationship.start);
        const endIdentity = identities.get(relationship.end);
        return (
          candidate.type === relationship.type &&
          startIdentity &&
          endIdentity &&
          sameIdentity(start, startIdentity) &&
          sameIdentity(end, endIdentity)
        );
      }),
    );
    checks.push({
      anchor: check.anchor,
      status: missingNodes.length === 0 && missingRelationships.length === 0 ? "PASS" : "FAIL",
      missingNodes,
      missingRelationships,
    });
  }
  return checks;
}

function evaluateRetrieval(question, evidence) {
  const identities = sourceRefIndex(question);
  const evidenceNodeIdentities = new Set((evidence?.nodes ?? []).map(nodeIdentity));
  const missingRequiredEvidence = (question.requiredEvidence ?? []).filter((sourceRefId) => {
    const identity = identities.get(sourceRefId);
    return !identity || !evidenceNodeIdentities.has(`${identity.label}:${identity.key}`);
  });
  const presentSupportingEvidence = (question.supportingEvidence ?? []).filter((sourceRefId) => {
    const identity = identities.get(sourceRefId);
    return identity && evidenceNodeIdentities.has(`${identity.label}:${identity.key}`);
  });
  return {
    status: missingRequiredEvidence.length === 0 ? "PASS" : "FAIL",
    missingRequiredEvidence,
    presentSupportingEvidence,
    evidenceRelationships: [...new Set((evidence?.relationships ?? []).map((relationship) => relationship.type))].sort(),
  };
}

function sourceRefNeedle(sourceRef) {
  if (sourceRef.type === "post") return String(sourceRef.task);
  if (sourceRef.type === "comment") return String(sourceRef.commentId);
  throw new Error(`unsupported sourceRef type: ${sourceRef.type}`);
}

function evaluateOrder(question, answer) {
  const orderedEvents = question.orderedEvents ?? [];
  if (orderedEvents.length === 0) {
    return { status: "NOT_APPLICABLE", positions: [], missing: [] };
  }
  const refs = new Map(question.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
  let previous = -1;
  const positions = [];
  const missing = [];
  let strictlyIncreasing = true;
  for (const sourceRefId of orderedEvents) {
    const sourceRef = refs.get(sourceRefId);
    const needle = sourceRef ? sourceRefNeedle(sourceRef) : "";
    const index = needle ? answer.indexOf(needle) : -1;
    positions.push({ sourceRefId, needle, index });
    if (index < 0) {
      missing.push(sourceRefId);
      strictlyIncreasing = false;
      continue;
    }
    if (index <= previous) {
      strictlyIncreasing = false;
    }
    previous = index;
  }
  return {
    status: missing.length === 0 && strictlyIncreasing ? "PASS" : "FAIL",
    positions,
    missing,
  };
}

function deterministicChecks(question, graphChecks, queryBody, httpStatus) {
  const graphStatus = graphChecks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
  if (graphStatus !== "PASS") {
    return {
      http: httpStatus >= 200 && httpStatus < 300 ? "PASS" : "FAIL",
      graph: { status: graphStatus, checks: graphChecks },
      retrieval: { status: "NOT_EVALUATED", missingRequiredEvidence: [...(question.requiredEvidence ?? [])] },
      order: { status: "NOT_EVALUATED", positions: [], missing: [...(question.orderedEvents ?? [])] },
      failureBoundary: "GRAPH",
      failedAxes: ["G"],
    };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      http: "FAIL",
      graph: { status: graphStatus, checks: graphChecks },
      retrieval: { status: "NOT_EVALUATED", missingRequiredEvidence: [...(question.requiredEvidence ?? [])] },
      order: { status: "NOT_EVALUATED", positions: [], missing: [...(question.orderedEvents ?? [])] },
      failureBoundary: "ANSWER",
      failedAxes: [],
    };
  }
  const retrieval = evaluateRetrieval(question, queryBody?.evidence);
  if (retrieval.status !== "PASS") {
    return {
      http: "PASS",
      graph: { status: graphStatus, checks: graphChecks },
      retrieval,
      order: { status: "NOT_EVALUATED", positions: [], missing: [...(question.orderedEvents ?? [])] },
      failureBoundary: "RETRIEVAL",
      failedAxes: ["R"],
    };
  }
  const order = evaluateOrder(question, queryBody?.answer ?? "");
  return {
    http: "PASS",
    graph: { status: graphStatus, checks: graphChecks },
    retrieval,
    order,
    failureBoundary: order.status === "FAIL" ? "ANSWER" : "NONE",
    failedAxes: order.status === "FAIL" ? ["G"] : [],
  };
}

async function executeAttempt(baseUrl, question, labelCache = new Map(), signal) {
  const graphChecks = await evaluateGraphChecks(baseUrl, question, labelCache, signal);
  if (!graphChecks.every((check) => check.status === "PASS")) {
    const checks = deterministicChecks(question, graphChecks, null, 0);
    return {
      latencyMs: 0,
      httpStatus: 0,
      answer: "",
      evidence: { nodes: [], relationships: [] },
      cypher: null,
      error: null,
      deterministicChecks: checks,
    };
  }

  const query = await requestJson(`${baseUrl}/api/query`, {
    method: "POST",
    body: JSON.stringify({ question: question.question }),
    signal,
  });
  if (query.status >= 200 && query.status < 300 && !hasQueryResponseShape(query.body)) {
    return {
      latencyMs: query.latencyMs,
      httpStatus: query.status,
      answer: "",
      evidence: { nodes: [], relationships: [] },
      cypher: null,
      error: "query response contract mismatch",
    };
  }
  const evidence = hasEvidenceShape(query.body?.evidence) ? query.body.evidence : { nodes: [], relationships: [] };
  const answer = typeof query.body?.answer === "string" ? query.body.answer : "";
  const checks = deterministicChecks(question, graphChecks, { answer, evidence }, query.status);
  return {
    latencyMs: query.latencyMs,
    httpStatus: query.status,
    answer,
    evidence,
    cypher: typeof query.body?.cypher === "string" ? query.body.cypher : null,
    error: query.status >= 200 && query.status < 300 ? null : JSON.stringify(query.body),
    deterministicChecks: checks,
  };
}

function newRun({ suitePath, suiteHash, commit, stage, baseUrl, declaredQueryModel, repetitions }) {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    suitePath,
    suiteHash,
    commit,
    stage,
    baseUrl,
    declaredQueryModel,
    repetitions,
    startedAt: new Date().toISOString(),
    attempts: [],
  };
}

function compatibleRun(existing, expected) {
  const fields = ["schemaVersion", "suitePath", "suiteHash", "commit", "stage", "baseUrl", "declaredQueryModel", "repetitions"];
  const mismatches = fields.filter((field) => existing[field] !== expected[field]);
  return { ok: mismatches.length === 0, mismatches };
}

async function loadOrCreateRun(outPath, expected) {
  try {
    const existing = await readJson(outPath);
    const compatibility = compatibleRun(existing, expected);
    if (!compatibility.ok) {
      throw new Error(`existing run conditions differ: ${compatibility.mismatches.join(", ")}`);
    }
    if (!Array.isArray(existing.attempts)) {
      throw new Error("existing run attempts must be an array");
    }
    return existing;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return expected;
    }
    throw error;
  }
}

function completedAttemptKeys(run) {
  return new Set(
    run.attempts
      .filter((attempt) => attempt && !attempt.error)
      .map(attemptKey),
  );
}

function upsertAttempt(run, attempt) {
  const key = attemptKey(attempt);
  const existingIndex = run.attempts.findIndex((item) => attemptKey(item) === key);
  if (existingIndex >= 0) {
    run.attempts[existingIndex] = attempt;
    return;
  }
  run.attempts.push(attempt);
}

async function runEvaluation(options) {
  await assertPreflight(options);
  const suite = await readJson(options.suitePath);
  const suiteHash = await sha256File(options.suitePath);
  const expected = newRun({
    ...options,
    suiteHash,
    commit: gitCommit(),
  });
  let lock;
  try {
    lock = await acquireLock(options.outPath);
    const run = await loadOrCreateRun(options.outPath, expected);
    const completed = completedAttemptKeys(run);
    const labelCache = new Map();
    const abortController = new AbortController();
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      abortController.abort();
    };
    process.once("SIGINT", interrupt);
    try {
      for (const question of suite.questions) {
        for (let attemptNumber = 1; attemptNumber <= options.repetitions; attemptNumber += 1) {
          if (interrupted) {
            run.interruptedAt = new Date().toISOString();
            await writeJsonAtomic(options.outPath, run);
            return { run, interrupted: true };
          }
          const key = `${question.id}:${attemptNumber}`;
          if (completed.has(key)) continue;
          const startedAt = new Date().toISOString();
          let attempt;
          try {
            attempt = await executeAttempt(options.baseUrl, question, labelCache, abortController.signal);
          } catch (error) {
            if (abortController.signal.aborted || isAbortError(error)) {
              run.interruptedAt = new Date().toISOString();
              await writeJsonAtomic(options.outPath, run);
              return { run, interrupted: true };
            }
            attempt = {
              latencyMs: 0,
              httpStatus: 0,
              answer: "",
              evidence: { nodes: [], relationships: [] },
              cypher: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          if (abortController.signal.aborted) {
            run.interruptedAt = new Date().toISOString();
            await writeJsonAtomic(options.outPath, run);
            return { run, interrupted: true };
          }
          const record = {
            questionId: question.id,
            attempt: attemptNumber,
            startedAt,
            ...attempt,
          };
          upsertAttempt(run, record);
          await writeJsonAtomic(options.outPath, run);
          if (!attempt.error) {
            completed.add(key);
          }
        }
      }
      return { run, interrupted: false };
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  } finally {
    await releaseLock(lock);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runEvaluation(options);
    if (result.interrupted) {
      process.exitCode = 130;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export {
  deterministicChecks,
  evaluateOrder,
  evaluateGraphChecks,
  evaluateRetrieval,
  parseArgs,
  runEvaluation,
  sourceRefIdentity,
};
