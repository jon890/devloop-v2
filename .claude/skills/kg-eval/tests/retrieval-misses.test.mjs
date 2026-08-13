import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildRetrievalMissLock, canonicalBytes } from "../scripts/memory/retrieval-misses.mjs";

const HASH = `sha256:${"a".repeat(64)}`;

function fixture({ searched = false, outcome = "hit" } = {}) {
  const observation = {
    sourceRunKey: "fixture",
    query: "private query",
    topK: 10,
    requiredMemoryIds: ["mem-required"],
    retrievedMemoryIds: outcome === "miss" ? ["mem-other"] : ["mem-required"],
    memoryIndexHash: HASH,
    outcome,
  };
  const attempts = [{
    taskId: "MEM-EXP-001",
    condition: "agent-triggered",
    repetition: 1,
    agentMemoryCalls: searched ? 1 : 0,
    memoryCalls: searched ? 1 : 0,
    retrievalObservations: searched ? [observation] : [],
  }];
  const run = { suiteHash: "suite-hash", memoryIndexHash: HASH, attempts };
  const privateMissLock = {
    schemaVersion: "memory-private-miss-lock/v1",
    suiteHash: "suite-hash",
    sourceLockHash: "source-hash",
    memoryIndexHash: HASH,
    attempts: [{ taskId: "MEM-EXP-001", condition: "agent-triggered", repetition: 1, lexicalMiss: searched && outcome === "miss" }],
  };
  const privateMissLockBytes = canonicalBytes(privateMissLock);
  const utilityReport = {
    lexicalMissCount: searched && outcome === "miss" ? 1 : 0,
    retrievalObservationComplete: true,
    privateMissLockHash: createHash("sha256").update(privateMissLockBytes).digest("hex"),
  };
  const suite = { tasks: [{ id: "MEM-EXP-001", category: "experience-needed" }] };
  return { run, privateMissLock, privateMissLockBytes, utilityReport, suite };
}

test("zero search produces a deterministic empty miss lock without requiring a corpus copy", () => {
  const input = fixture();
  const first = buildRetrievalMissLock(input);
  const second = buildRetrievalMissLock(input);
  assert.equal(first.missCount, 0);
  assert.equal(first.corpus, null);
  assert.deepEqual(first.misses, []);
  assert.equal(canonicalBytes(first), canonicalBytes(second));
});

test("extracts only observed lexical false negatives and normalizes source keys", () => {
  const result = buildRetrievalMissLock(fixture({ searched: true, outcome: "miss" }));
  assert.equal(result.missCount, 1);
  assert.deepEqual(result.misses[0].sourceRunKeys, ["MEM-EXP-001:agent-triggered:1"]);
  assert.equal(result.misses[0].topK, 10);
});

test("fails closed for missing observations, public count drift, and private lock drift", () => {
  const missing = fixture({ searched: true });
  missing.run.attempts[0].retrievalObservations = [];
  assert.throws(() => buildRetrievalMissLock(missing), /unobserved/);

  const count = fixture({ searched: true, outcome: "miss" });
  count.utilityReport.lexicalMissCount = 0;
  assert.throws(() => buildRetrievalMissLock(count), /public count mismatch/);

  const hash = fixture();
  hash.utilityReport.privateMissLockHash = "0".repeat(64);
  assert.throws(() => buildRetrievalMissLock(hash), /private lock hash mismatch/);
});
