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

test('anchor 후보가 한 라벨에 몰려도 Wiki 슬롯과 라벨별 최대 정원을 지킨다', () => {
  const resultSet = [
    ...Array.from({ length: 6 }, (_, index) => ({
      node: node(`task-${index}`, 'Task'),
      score: 20 - index,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      node: node(`concept-${index}`, 'Concept'),
      score: 14 - index,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      node: node(`wiki-${index}`, 'Wiki'),
      score: 9 - index,
    })),
  ];

  const anchors = rankAnchorCandidates([resultSet]);
  const labelCounts = anchors.reduce(
    (counts, anchor) => ({ ...counts, [anchor.label]: (counts[anchor.label] ?? 0) + 1 }),
    {},
  );

  assert.equal(anchors.length, 8);
  assert.equal(labelCounts.Wiki, 2);
  assert.equal(labelCounts.Task, 5);
  assert.equal(labelCounts.Concept, 1);
  assert.deepEqual(
    anchors.filter(({ label }) => label === 'Wiki').map(({ id }) => id),
    ['wiki-0', 'wiki-1'],
  );
});

test('생성된 한영 표기 변형에 질문 원문을 중복 없이 추가하고 모든 후보를 합산한다', async () => {
  const terms = ['게이트웨이', 'gateway', 'API Gateway', '제거'];
  const question = '게이트웨이 뺀 거 왜 그랬지?';
  const searchedTerms = [];
  const searchLimits = [];
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
  service.fulltextSearch = async (term, limit) => {
    searchedTerms.push(term);
    searchLimits.push(limit);
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

  await service.query({ question });

  assert.deepEqual(searchedTerms, [...terms, question]);
  assert.deepEqual(searchLimits, Array(terms.length + 1).fill(8));
  assert.equal(generatedCandidates[0].node.id, 'task-483');
  assert.equal(generatedCandidates[0].decisionCount, 8);
  assert.ok(generatedCandidates.some(({ node: candidate }) => candidate.id === 'task-489'));
});

test('LLM이 질문 원문 전체를 반환해도 검색어를 중복 추가하지 않는다', async () => {
  const question = 'Log & Crash 쓰는 법 어디 봐야 해?';
  const searchedTerms = [];
  const service = new GraphQueryService({}, {
    async complete() {
      return { text: JSON.stringify({ terms: ['Log & Crash', question] }) };
    },
  });
  service.fulltextSearch = async (term) => {
    searchedTerms.push(term);
    return [];
  };
  service.generateCypher = async () => 'MATCH (n) RETURN n LIMIT 1';
  service.executeGeneratedCypher = async (cypher) => ({
    ok: true,
    cypher,
    rows: [],
    evidence: { nodes: [], relationships: [] },
  });
  service.buildQueryEvidence = async () => ({ nodes: [], relationships: [] });
  service.synthesizeAnswer = async () => '문서';

  await service.query({ question });

  assert.deepEqual(searchedTerms, ['Log & Crash', question]);
});

test('근거 상한 밖의 Task도 답변에서 안정적인 Task 번호 형식으로 인용한다', async () => {
  const task206 = {
    ...node('task-206', 'Task', '클라우드트레일 이벤트 제거'),
    key: '206',
  };
  const service = new GraphQueryService({}, {});
  service.extractAnchorTerms = async () => ['CloudTrail'];
  service.fulltextSearch = async () => [];
  service.generateCypher = async () => 'MATCH (t:Task) RETURN t LIMIT 50';
  service.executeGeneratedCypher = async (cypher) => ({
    ok: true,
    cypher,
    rows: [{ t: task206 }],
    evidence: { nodes: [task206], relationships: [] },
  });
  service.buildQueryEvidence = async () => ({ nodes: [], relationships: [] });
  service.synthesizeAnswer = async () => '21. #206 클라우드트레일 이벤트 제거';

  const response = await service.query({ question: 'CloudTrail Task를 반환해줘.' });

  assert.equal(response.answer, '21. Task #206 클라우드트레일 이벤트 제거');
  assert.deepEqual(response.evidence.nodes, []);
});

test('fulltext 검색은 인덱스별 후보를 전역 LIMIT 없이 RRF 단계로 전달한다', async () => {
  let executedCypher;
  let executedParams;
  const neo4jService = {
    async executeRead(work) {
      return work({
        async run(cypher, params) {
          executedCypher = cypher;
          executedParams = params;
          return { records: [] };
        },
      });
    },
  };
  const service = new GraphQueryService(neo4jService, {});

  await service.fulltextSearch('모델 서버', 8);

  assert.match(executedCypher, /queryNodes\(indexName, \$q, \{limit: \$perIndexLimit\}\)/);
  assert.doesNotMatch(executedCypher, /LIMIT \$limit/);
  assert.deepEqual(executedParams.indexes, [
    'task_subject_fulltext',
    'wiki_subject_fulltext',
    'concept_name_fulltext',
  ]);
  assert.equal(executedParams.perIndexLimit.toNumber(), 8);
  assert.equal('limit' in executedParams, false);
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
