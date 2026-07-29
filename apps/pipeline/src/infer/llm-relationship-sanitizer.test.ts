import assert from "node:assert/strict";
import test from "node:test";
import type { DroppedRelationship } from "./llm-relationship-sanitizer";
import { sanitizeLlmRecords, type EndpointIndex, type LlmGraphRecord } from "./llm-relationship-sanitizer";

function buildIndex(overrides: Partial<EndpointIndex> = {}): EndpointIndex {
  return {
    taskNumbers: new Set(["1"]),
    taskIdToNumber: new Map([["task-legacy-id", "1"]]),
    wikiPageIds: new Set(["100"]),
    wikiIdToPageId: new Map([["wiki-legacy-id", "100"]]),
    ...overrides,
  };
}

function mentionsRelationship(startKey: string, endKey: string): LlmGraphRecord {
  return {
    type: "MENTIONS",
    startKey,
    endKey,
    properties: { sourceDocId: "Task:1" },
  };
}

test("종점을 색인에서 확인할 수 없는 관계는 droppedRelationships 에 들어가고 records 에서 빠진다", () => {
  const index = buildIndex();
  const relationship = mentionsRelationship("Task:999", "Concept:OCR");
  const result = sanitizeLlmRecords([relationship], [], index);

  assert.equal(result.records.length, 0);
  assert.equal(result.droppedRelationships.count, 1);
  assert.equal(result.droppedRelationships.documents[0].relationships[0].relationship, relationship);
});

test("옛 id 로 적힌 종점은 raw 색인의 현재 번호로 재작성되고 rewrittenRelationships 가 증가한다", () => {
  const index = buildIndex();
  const relationship = mentionsRelationship("Task:task-legacy-id", "Concept:OCR");
  const result = sanitizeLlmRecords([relationship], [], index);

  assert.equal(result.rewrittenRelationships, 1);
  assert.equal(result.records.length, 1);
  const [sanitized] = result.records;
  assert.ok("startKey" in sanitized);
  assert.equal(sanitized.startKey, "Task:1");
  assert.equal(result.droppedRelationships.count, 0);
});

test("previousDropped 로 넘긴 누적분이 결과에 유지된다", () => {
  const index = buildIndex();
  const previousDropped: DroppedRelationship[] = [
    {
      relationship: mentionsRelationship("Task:888", "Concept:Legacy") as Extract<LlmGraphRecord, { type: string }>,
      reason: "Task endpoint Task:888 is absent from the raw task number and post id indexes.",
    },
  ];
  const result = sanitizeLlmRecords([], previousDropped, index);

  assert.equal(result.droppedRelationships.count, 1);
  assert.equal(result.droppedRelationships.documents[0].relationships[0].reason, previousDropped[0].reason);
});
