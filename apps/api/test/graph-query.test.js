const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  GraphQueryService,
  rankAnchorCandidates,
  refineQueryEvidence,
} = require('../dist/graph-query.service');

function node(id, label, display = id) {
  return { id, label, key: id, display, properties: {} };
}

test('query evidence prioritizes answer nodes, filters orphan anchors, and caps nodes at 30', () => {
  const answerNodes = [
    node('answer-concept', 'Concept'),
    node('answer-task', 'Task'),
  ];
  const supportingNodes = Array.from({ length: 35 }, (_, index) =>
    node(`support-${index}`, index % 2 === 0 ? 'Task' : 'Concept'),
  );
  const relationships = supportingNodes.map((supportingNode, index) => ({
    id: `relationship-${index}`,
    type: 'RELATES_TO',
    startId: answerNodes[index % answerNodes.length].id,
    endId: supportingNode.id,
    properties: {},
  }));
  const connectedAnchor = node('connected-anchor', 'Wiki');
  relationships.push({
    id: 'anchor-relationship',
    type: 'RELATES_TO',
    startId: 'answer-task',
    endId: connectedAnchor.id,
    properties: {},
  });

  const evidence = refineQueryEvidence(
    { nodes: answerNodes, relationships: [] },
    { nodes: supportingNodes, relationships },
    [connectedAnchor, node('orphan-anchor', 'Task')],
  );

  assert.equal(evidence.nodes.length, 30);
  assert.deepEqual(
    evidence.nodes.slice(0, 2).map((item) => item.id),
    ['answer-task', 'answer-concept'],
  );
  assert.ok(evidence.nodes.some((item) => item.id === 'connected-anchor'));
  assert.ok(evidence.nodes.every((item) => item.id !== 'orphan-anchor'));
  const selectedIds = new Set(evidence.nodes.map((item) => item.id));
  assert.ok(
    evidence.relationships.every(
      (relationship) =>
        selectedIds.has(relationship.startId) && selectedIds.has(relationship.endId),
    ),
  );
});

test('anchor 검색 결과를 중복 관련도 순으로 합쳐 상위 8개 후보를 유지한다', () => {
  const firstResultSet = Array.from({ length: 10 }, (_, index) => ({
    node: node(`first-${index}`, 'Task'),
    score: 10 - index,
  }));
  const secondResultSet = [
    { node: firstResultSet[1].node, score: 9.5 },
    ...Array.from({ length: 9 }, (_, index) => ({
      node: node(`second-${index}`, 'Wiki'),
      score: 9 - index,
    })),
  ];

  const anchors = rankAnchorCandidates([firstResultSet, secondResultSet]);

  assert.equal(anchors.length, 8);
  assert.equal(anchors[0].id, 'first-1');
  assert.ok(anchors.some((anchor) => anchor.id === 'first-0'));
  assert.ok(anchors.some((anchor) => anchor.id.startsWith('second-')));
});

test('생성된 한영 표기 변형을 모두 검색하고 영문 검색 후보를 합산한다', async () => {
  const terms = ['게이트웨이', 'gateway', 'API Gateway', '제거'];
  const searchedTerms = [];
  let generatedCandidates;
  const task483 = {
    ...node('task-483', 'Task', '[OCR] API Gateway 제거'),
    key: '483',
  };
  const task489 = {
    ...node('task-489', 'Task', '게이트웨이 장애 대응'),
    key: '489',
  };
  const llmCli = {
    async complete() {
      return { text: JSON.stringify({ terms }) };
    },
  };
  const service = new GraphQueryService({}, llmCli);
  service.fulltextSearch = async (term) => {
    searchedTerms.push(term);
    if (term === 'gateway' || term === 'API Gateway') {
      return [{ node: task483, score: 9 }];
    }
    if (term === '게이트웨이') {
      return [{ node: task489, score: 8 }];
    }
    return [];
  };
  service.countTaskDecisions = async () => new Map([
    ['task-483', 8],
    ['task-489', 0],
  ]);
  service.generateCypher = async (_question, candidates) => {
    generatedCandidates = candidates;
    return 'MATCH (n) RETURN n LIMIT 1';
  };
  service.executeGeneratedCypher = async (cypher) => ({
    ok: true,
    cypher,
    rows: [],
    evidence: { nodes: [], relationships: [] },
  });
  service.buildQueryEvidence = async () => ({ nodes: [], relationships: [] });
  service.synthesizeAnswer = async () => 'API Gateway 제거 근거';

  await service.query({ question: '게이트웨이 뺀 거 왜 그랬지?' });

  assert.deepEqual(searchedTerms, terms);
  assert.equal(generatedCandidates[0].node.id, 'task-483');
  assert.equal(generatedCandidates[0].decisionCount, 8);
  assert.ok(generatedCandidates.some(({ node: candidate }) => candidate.id === 'task-489'));
});

test('Task anchor 후보만 Decision 연결 수를 함께 조회한다', async () => {
  let executedCypher;
  let executedParams;
  const neo4jService = {
    async executeRead(work) {
      return work({
        async run(cypher, params) {
          executedCypher = cypher;
          executedParams = params;
          return {
            records: [
              { get: (key) => ({ taskId: 'task-483', decisionCount: 8 })[key] },
              { get: (key) => ({ taskId: 'task-489', decisionCount: 0 })[key] },
            ],
          };
        },
      });
    },
  };
  const service = new GraphQueryService(neo4jService, {});

  const counts = await service.countTaskDecisions([
    node('task-483', 'Task'),
    node('wiki-1', 'Wiki'),
    node('task-489', 'Task'),
  ]);

  assert.deepEqual(executedParams, { taskIds: ['task-483', 'task-489'] });
  assert.match(executedCypher, /OPTIONAL MATCH \(d:Decision\)-\[:DECIDED_IN\]->\(t\)/);
  assert.match(executedCypher, /count\(DISTINCT d\) AS decisionCount/);
  assert.equal(counts.get('task-483'), 8);
  assert.equal(counts.get('task-489'), 0);
});
