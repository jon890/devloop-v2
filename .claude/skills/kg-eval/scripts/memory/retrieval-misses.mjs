#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadMemorySuite } from "./suite.mjs";

const SCHEMA_VERSION = "memory-retrieval-miss-lock/v1";
const SOURCE_LOCK_SCHEMA_VERSION = "memory-private-miss-lock/v1";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalBytes(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function attemptKey(attempt) {
  return `${attempt.taskId}:${attempt.condition}:${attempt.repetition}`;
}

function retrievalObservations(attempt) {
  return Array.isArray(attempt.retrievalObservations) ? attempt.retrievalObservations : [];
}

function memoryCallCount(attempt) {
  return attempt.agentMemoryCalls ?? attempt.memoryCalls ?? 0;
}

function validateObservation(observation, runMemoryIndexHash) {
  if (!isPlainObject(observation)) throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: invalid observation");
  for (const field of ["sourceRunKey", "query", "topK", "requiredMemoryIds", "retrievedMemoryIds", "memoryIndexHash", "outcome"]) {
    if (!(field in observation)) throw new Error(`PHASE_BLOCKED: lexical miss 근거 불일치: observation.${field} missing`);
  }
  if (typeof observation.sourceRunKey !== "string" || observation.sourceRunKey.length === 0) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: sourceRunKey invalid");
  }
  if (typeof observation.query !== "string" || observation.query.trim().length === 0) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: query invalid");
  }
  if (observation.topK !== 10) throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: topK must be 10");
  if (!Array.isArray(observation.requiredMemoryIds) || !Array.isArray(observation.retrievedMemoryIds)) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: Memory IDs invalid");
  }
  if (observation.memoryIndexHash !== runMemoryIndexHash) {
    throw new Error("PHASE_BLOCKED: retrieval corpus 변경");
  }
  if (!new Set(["hit", "miss", "unobserved"]).has(observation.outcome)) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: outcome invalid");
  }
}

function isMiss(observation) {
  const required = sortedStrings(observation.requiredMemoryIds);
  const retrieved = new Set(sortedStrings(observation.retrievedMemoryIds));
  return required.length > 0 && required.every((id) => !retrieved.has(id));
}

function validateSourceAttempts(run, privateMissLock) {
  if (!Array.isArray(run.attempts) || !Array.isArray(privateMissLock.attempts)) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: attempts missing");
  }
  if (privateMissLock.schemaVersion !== SOURCE_LOCK_SCHEMA_VERSION || privateMissLock.memoryIndexHash !== run.memoryIndexHash) {
    throw new Error("PHASE_BLOCKED: retrieval corpus 변경");
  }
  const privateByKey = new Map();
  for (const attempt of privateMissLock.attempts) {
    const key = attemptKey(attempt);
    if (privateByKey.has(key)) throw new Error(`PHASE_BLOCKED: lexical miss 근거 불일치: duplicate ${key}`);
    privateByKey.set(key, attempt);
  }
  if (privateByKey.size !== run.attempts.length) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: attempt count mismatch");
  }
  for (const attempt of run.attempts) {
    const source = privateByKey.get(attemptKey(attempt));
    if (!source || source.lexicalMiss !== false && source.lexicalMiss !== true) {
      throw new Error(`PHASE_BLOCKED: lexical miss 근거 불일치: ${attemptKey(attempt)}`);
    }
  }
}

function buildRetrievalMissLock({ run, utilityReport, privateMissLock, privateMissLockBytes, suite }) {
  validateSourceAttempts(run, privateMissLock);
  const privateMissLockHash = sha256(privateMissLockBytes);
  if (utilityReport.privateMissLockHash !== privateMissLockHash) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: private lock hash mismatch");
  }
  if (utilityReport.retrievalObservationComplete !== true) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: retrieval observation incomplete");
  }

  const taskById = new Map(suite.tasks.map((task) => [task.id, task]));
  const misses = [];
  for (const attempt of run.attempts) {
    if (attempt.condition !== "agent-triggered" || taskById.get(attempt.taskId)?.category !== "experience-needed") continue;
    const observations = retrievalObservations(attempt);
    if (memoryCallCount(attempt) > 0 && observations.length === 0) {
      throw new Error(`PHASE_BLOCKED: lexical miss 근거 불일치: unobserved ${attemptKey(attempt)}`);
    }
    for (const observation of observations) {
      validateObservation(observation, run.memoryIndexHash);
      if (observation.outcome === "unobserved") {
        throw new Error(`PHASE_BLOCKED: lexical miss 근거 불일치: unobserved ${attemptKey(attempt)}`);
      }
      if (!isMiss(observation)) continue;
      misses.push({
        taskId: attempt.taskId,
        query: observation.query,
        requiredMemoryIds: sortedStrings(observation.requiredMemoryIds),
        retrievedMemoryIds: sortedStrings(observation.retrievedMemoryIds),
        sourceRunKeys: [attemptKey(attempt)],
        topK: observation.topK,
        memoryIndexHash: observation.memoryIndexHash,
      });
    }
  }
  misses.sort((left, right) => left.taskId.localeCompare(right.taskId) || left.query.localeCompare(right.query));
  if (utilityReport.lexicalMissCount !== misses.length) {
    throw new Error("PHASE_BLOCKED: lexical miss 근거 불일치: public count mismatch");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceRunHash: sha256(canonicalBytes(run)),
    utilityReportHash: sha256(canonicalBytes(utilityReport)),
    utilityPrivateMissLockHash: privateMissLockHash,
    suiteHash: run.suiteHash,
    memoryIndexHash: run.memoryIndexHash,
    retrievalObservationComplete: true,
    missCount: misses.length,
    corpus: misses.length === 0 ? null : { wikiGenerationId: null, corpusIndexPath: null, corpusIndexHash: run.memoryIndexHash },
    misses,
  };
}

function parseArgs(argv) {
  const values = new Set(["--run", "--utility-report", "--private-miss-lock", "--suite", "--out"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!values.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  for (const required of ["run", "utility-report", "private-miss-lock", "suite", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write("Usage: retrieval-misses.mjs --run <run.json> --utility-report <report.json> --private-miss-lock <lock.json> --suite <suite.json> --out <misses.json>\n");
      return;
    }
    const [runText, reportText, privateText, loadedSuite] = await Promise.all([
      readFile(args.run, "utf8"),
      readFile(args["utility-report"], "utf8"),
      readFile(args["private-miss-lock"], "utf8"),
      loadMemorySuite(args.suite),
    ]);
    const lock = buildRetrievalMissLock({
      run: JSON.parse(runText),
      utilityReport: JSON.parse(reportText),
      privateMissLock: JSON.parse(privateText),
      privateMissLockBytes: privateText,
      suite: loadedSuite.suite,
    });
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, canonicalBytes(lock), "utf8");
    process.stdout.write(`${JSON.stringify({ missCount: lock.missCount, retrievalObservationComplete: true })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

export { buildRetrievalMissLock, canonicalBytes, parseArgs };
