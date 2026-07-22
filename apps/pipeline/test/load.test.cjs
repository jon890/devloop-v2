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
});
