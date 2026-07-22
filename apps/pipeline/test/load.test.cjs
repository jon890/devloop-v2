const assert = require('node:assert/strict');
const test = require('node:test');

const { buildConceptAliasMap, normalizeGraph } = require('../dist/load/load');

test('label:key 관계 끝점을 실제 노드 키와 Concept canonical로 정규화한다', () => {
  const aliasMap = buildConceptAliasMap([
    { canonical: 'OCR.API', kind: 'component', aliases: ['OCR API'] },
  ]);
  const graph = normalizeGraph(
    [
      { label: 'Task', key: '483', properties: { number: '483' } },
      { label: 'Concept', key: 'OCR API', properties: { name: 'OCR API', kind: 'component' } },
    ],
    [
      {
        type: 'MENTIONS',
        startKey: 'Task:483',
        endKey: 'Concept:OCR API',
        properties: {},
      },
    ],
    aliasMap,
  );

  assert.ok(graph.nodes.some((node) => node.label === 'Task' && node.key === '483'));
  assert.ok(graph.nodes.some((node) => node.label === 'Concept' && node.key === 'OCR.API'));
  assert.deepEqual(graph.relationships, [
    {
      type: 'MENTIONS',
      startKey: '483',
      endKey: 'OCR.API',
      properties: { startLabel: 'Task', endLabel: 'Concept' },
    },
  ]);
  assert.deepEqual(graph.skippedRelationships, { count: 0, samples: [] });
});

test('LLM 유래 미해석 관계는 최대 10개 샘플과 함께 건너뛴다', () => {
  const relationships = Array.from({ length: 12 }, (_, index) => ({
    type: 'RELATES_TO',
    startKey: 'Task:483',
    endKey: `Task:${900 + index}`,
    properties: { kind: 'follows-up', sourceDocId: 'Task:483' },
  }));
  const graph = normalizeGraph(
    [{ label: 'Task', key: '483', properties: { number: '483' } }],
    relationships,
    new Map(),
    relationships.map(() => 'llm.jsonl'),
  );

  assert.equal(graph.relationships.length, 0);
  assert.equal(graph.skippedRelationships.count, 12);
  assert.equal(graph.skippedRelationships.samples.length, 10);
  assert.ok(graph.skippedRelationships.samples.every((sample) => sample.sourceFile === 'llm.jsonl'));
  assert.match(graph.skippedRelationships.samples[0].error, /Missing endKey node/);
});

test('structural.jsonl 유래 미해석 관계는 구조적 버그로 계속 실패한다', () => {
  assert.throws(
    () => normalizeGraph(
      [{ label: 'Task', key: '483', properties: { number: '483' } }],
      [{
        type: 'REFERENCES',
        startKey: 'Task:483',
        endKey: 'Task:999',
        properties: { project: 'tc-ocr' },
      }],
      new Map(),
      ['structural.jsonl'],
    ),
    /Missing endKey node "Task:999"/,
  );
});
