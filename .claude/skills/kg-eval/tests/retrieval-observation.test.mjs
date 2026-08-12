import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonl } from "../scripts/memory/telemetry.mjs";
import { memorySearchDetails, retrievalObservations } from "../scripts/memory/retrieval-observation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures", "memory");
const CURRENT_HASH = `sha256:${"a".repeat(64)}`;

async function fixtureEvents(name) {
  return parseJsonl(await readFile(path.join(fixtures, name), "utf8"));
}

test("extracts query and default topK from memory-search argv", () => {
  assert.deepEqual(memorySearchDetails("pnpm --silent memory-search -- --query fail-fast --project tc-ocr --allow-incomplete"), {
    query: "fail-fast",
    topK: 10,
  });
  assert.deepEqual(memorySearchDetails(["memory-search", "--query", "migration", "--top-k", "3"]), {
    query: "migration",
    topK: 3,
  });
  assert.equal(memorySearchDetails("pnpm --silent memory-search -- --top-k 3"), null);
});

test("normalizes Codex same-item command output into retrieval observation", async () => {
  const observations = retrievalObservations({
    agent: "codex",
    events: await fixtureEvents("codex-command.jsonl"),
    sourceRunKey: "RUN-CODEX",
    requiredMemoryIds: new Map([[10, ["mem-fail-fast", "mem-other"]]]),
    currentMemoryIndexHash: CURRENT_HASH,
  });
  assert.deepEqual(observations, [
    {
      sourceRunKey: "RUN-CODEX",
      query: "fail-fast",
      topK: 10,
      requiredMemoryIds: ["mem-fail-fast", "mem-other"],
      retrievedMemoryIds: ["mem-fail-fast"],
      memoryIndexHash: CURRENT_HASH,
      outcome: "hit",
    },
  ]);
});

test("normalizes Claude tool_use id to tool_result output into retrieval observation", async () => {
  const observations = retrievalObservations({
    agent: "claude",
    events: await fixtureEvents("claude-command.jsonl"),
    sourceRunKey: "RUN-CLAUDE",
    requiredMemoryIds: new Map([[10, ["mem-required"]]]),
    currentMemoryIndexHash: CURRENT_HASH,
  });
  assert.deepEqual(observations, [
    {
      sourceRunKey: "RUN-CLAUDE",
      query: "migration",
      topK: 10,
      requiredMemoryIds: ["mem-required"],
      retrievedMemoryIds: ["mem-migration"],
      memoryIndexHash: CURRENT_HASH,
      outcome: "miss",
    },
  ]);
});

test("does not grant required IDs or hit/miss when observed output belongs to a different index hash", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "pnpm --silent memory-search -- --query q --top-k 2",
        output: JSON.stringify({ memoryIndexHash: `sha256:${"b".repeat(64)}`, results: [{ id: "mem-required" }] }),
      },
    },
  ];
  const [observation] = retrievalObservations({
    agent: "codex",
    events,
    sourceRunKey: "RUN-HASH",
    requiredMemoryIds: new Map([[2, ["mem-required"]]]),
    currentMemoryIndexHash: CURRENT_HASH,
  });
  assert.deepEqual(observation.requiredMemoryIds, []);
  assert.deepEqual(observation.retrievedMemoryIds, ["mem-required"]);
  assert.equal(observation.memoryIndexHash, `sha256:${"b".repeat(64)}`);
  assert.equal(observation.outcome, "unobserved");
});

test("marks memory calls unobserved when output JSON, memoryIndexHash, or paired command data is missing", () => {
  const codex = retrievalObservations({
    agent: "codex",
    events: [{ type: "item.completed", item: { type: "command_execution", command: "pnpm --silent memory-search -- --query q", output: "not json" } }],
    sourceRunKey: "RUN-UNOBSERVED",
    requiredMemoryIds: new Map([[10, ["mem-required"]]]),
    currentMemoryIndexHash: CURRENT_HASH,
  });
  assert.equal(codex[0].outcome, "unobserved");
  assert.equal(codex[0].query, "q");
  assert.equal(codex[0].memoryIndexHash, null);

  const missingHash = retrievalObservations({
    agent: "codex",
    events: [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "pnpm --silent memory-search -- --query q",
          output: JSON.stringify({ results: [{ id: "mem-required" }] }),
        },
      },
    ],
    sourceRunKey: "RUN-MISSING-HASH",
    requiredMemoryIds: new Map([[10, ["mem-required"]]]),
    currentMemoryIndexHash: CURRENT_HASH,
  });
  assert.deepEqual(missingHash[0].requiredMemoryIds, []);
  assert.deepEqual(missingHash[0].retrievedMemoryIds, ["mem-required"]);
  assert.equal(missingHash[0].memoryIndexHash, null);
  assert.equal(missingHash[0].outcome, "unobserved");

  const claude = retrievalObservations({
    agent: "claude",
    events: [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm --silent memory-search -- --query q" } }] },
      },
    ],
    sourceRunKey: "RUN-UNPAIRED",
    requiredMemoryIds: new Map([[10, ["mem-required"]]]),
    currentMemoryIndexHash: CURRENT_HASH,
  });
  assert.deepEqual(claude[0], {
    sourceRunKey: "RUN-UNPAIRED",
    query: "q",
    topK: 10,
    requiredMemoryIds: [],
    retrievedMemoryIds: [],
    memoryIndexHash: null,
    outcome: "unobserved",
  });
});
