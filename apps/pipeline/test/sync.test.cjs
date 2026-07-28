const assert = require('node:assert/strict');
const test = require('node:test');

const { buildConceptAliasMap, normalizeGraph } = require('../dist/neo4j/sync');

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

test('Task number만 정수 키로 정규화하고 Comment·Wiki 키는 문자열로 유지한다', () => {
  const graph = normalizeGraph(
    [
      { label: 'Task', key: '483', properties: { number: 483 } },
      { label: 'Comment', key: '4350352062068741480', properties: { commentId: '4350352062068741480' } },
      { label: 'Wiki', key: '3052841357365230129', properties: { pageId: '3052841357365230129' } },
    ],
    [],
    new Map(),
  );

  const task = graph.nodes.find((node) => node.label === 'Task');
  const comment = graph.nodes.find((node) => node.label === 'Comment');
  const wiki = graph.nodes.find((node) => node.label === 'Wiki');
  assert.equal(task.properties.number, 483);
  assert.equal(typeof task.properties.number, 'number');
  assert.equal(comment.properties.commentId, '4350352062068741480');
  assert.equal(typeof comment.properties.commentId, 'string');
  assert.equal(wiki.properties.pageId, '3052841357365230129');
  assert.equal(typeof wiki.properties.pageId, 'string');
});
