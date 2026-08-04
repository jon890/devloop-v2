const assert = require('node:assert/strict');
const { test } = require('node:test');
const { takeWithinBudget, buildAnswerEvidencePayload, refineQueryEvidence } = require('../dist/query/query.service');
const { EVIDENCE_NODE_CEILING, EVIDENCE_SERIALIZED_BUDGET, ANSWER_EVIDENCE_PROMPT_BUDGET } = require('../dist/query/query.const');

function node(id, label, textLength = 0) {
  return { id, label, key: id, display: id, properties: { excerpt: 'ㄱ'.repeat(textLength) } };
}

const rel = (id, startId, endId) => ({ id, type: 'HAS_COMMENT', startId, endId, properties: {} });

test('예산은 개수가 아니라 직렬화 길이로 자른다', () => {
  const small = Array.from({ length: 40 }, (_, index) => node(`s-${index}`, 'Task', 10));
  assert.equal(takeWithinBudget(small, 60_000, 80).length, 40, '짧은 노드는 40개가 다 들어간다');

  const large = Array.from({ length: 40 }, (_, index) => node(`l-${index}`, 'Task', 6_000));
  const taken = takeWithinBudget(large, 60_000, 80);
  assert.ok(taken.length < 40, '긴 노드는 예산에서 걸린다');
  assert.ok(JSON.stringify(taken).length <= 60_000 + JSON.stringify(large[0]).length, '예산을 크게 넘지 않는다');
});

test('첫 노드는 예산을 넘어도 담아 근거가 0건이 되지 않게 한다', () => {
  const huge = [node('h-1', 'Comment', 100_000)];
  assert.equal(takeWithinBudget(huge, 1_000, 80).length, 1);
});

test('개수 상한이 예산보다 먼저 걸리면 그것을 지킨다', () => {
  const tiny = Array.from({ length: 200 }, (_, index) => node(`t-${index}`, 'Task', 1));
  assert.equal(takeWithinBudget(tiny, 10_000_000, EVIDENCE_NODE_CEILING).length, EVIDENCE_NODE_CEILING);
});

test('프롬프트 근거는 문자 중간을 베지 않고 항상 유효한 JSON 이다', () => {
  const nodes = Array.from({ length: 30 }, (_, index) => node(`n-${index}`, 'Comment', 6_000));
  const relationships = [rel('r-0', 'n-0', 'n-1'), rel('r-1', 'n-0', 'n-29')];

  const payload = buildAnswerEvidencePayload({ nodes, relationships }, ANSWER_EVIDENCE_PROMPT_BUDGET);

  const parsed = JSON.parse(payload); // 문자 절단이면 여기서 던진다
  assert.ok(parsed.nodes.length < nodes.length, '예산을 넘는 노드는 빠진다');
  assert.ok(parsed.omittedNodes > 0, '빠진 개수를 드러낸다');
  assert.ok(
    parsed.relationships.every((relationship) => parsed.nodes.some((item) => item.id === relationship.startId)),
    '남은 관계의 끝점은 담긴 노드 안에 있다',
  );
});

test('근거 정제는 Comment 를 Concept 보다 먼저 남긴다', () => {
  const comment = node('c-1', 'Comment', 10);
  const concept = node('k-1', 'Concept', 10);
  const task = node('t-1', 'Task', 10);
  const answerEvidence = { nodes: [], relationships: [] };
  const supporting = {
    nodes: [concept, comment, task],
    relationships: [rel('r-1', 't-1', 'c-1'), rel('r-2', 't-1', 'k-1')],
  };

  const refined = refineQueryEvidence(answerEvidence, supporting, []);
  const order = refined.nodes.map((item) => item.label);

  assert.deepEqual(order, ['Task', 'Comment', 'Concept'], '라벨 우선순위가 Task → Comment → Concept 이다');
});

test('예산 상수가 프롬프트 예산보다 커서 응답이 프롬프트에 종속되지 않는다', () => {
  assert.ok(EVIDENCE_SERIALIZED_BUDGET > ANSWER_EVIDENCE_PROMPT_BUDGET);
});

// 독립 검토가 실측한 회귀다. 관계 직렬화가 프롬프트 예산을 넘는 회차에서 노드 예산이 0이 되어
// 프롬프트가 노드 1건만 받았다 (9회 중 3회). 그 조건을 재현해 고정한다.
test('관계가 예산을 넘겨도 프롬프트 노드가 1건으로 무너지지 않는다', () => {
  const nodes = Array.from({ length: 26 }, (_, index) => node(`n-${index}`, 'Comment', 400));
  // 관계 108건이 24,030자를 차지했던 회차를 재현한다.
  const relationships = Array.from({ length: 108 }, (_, index) =>
    rel(`r-${index}`.padEnd(200, 'x'), `n-${index % 26}`, `n-${(index + 1) % 26}`),
  );
  assert.ok(JSON.stringify(relationships).length > ANSWER_EVIDENCE_PROMPT_BUDGET, '이 fixture 는 관계가 예산을 넘는 조건이다');

  const parsed = JSON.parse(buildAnswerEvidencePayload({ nodes, relationships }, ANSWER_EVIDENCE_PROMPT_BUDGET));

  assert.ok(parsed.nodes.length >= 10, `노드가 충분히 담겨야 한다 (실제 ${parsed.nodes.length}건)`);
  assert.ok(parsed.omittedRelationships > 0, '빠진 관계 수를 드러낸다');
});

test('예산에 안 맞는 항목을 만나면 멈춰 우선순위를 지킨다', () => {
  const ordered = [node('first', 'Task', 100), node('big', 'Comment', 6_000), node('small', 'Concept', 10)];

  const taken = takeWithinBudget(ordered, JSON.stringify(ordered[0]).length + 500, 80);

  assert.deepEqual(
    taken.map((item) => item.id),
    ['first'],
    '뒤쪽 짧은 노드가 예산에 걸린 앞 노드를 추월하지 않는다',
  );
});

// 실측 회귀다. 다수 업무 조회를 collect 로 접으라는 프롬프트 지시 때문에 일반 질의가 집계로
// 오판정됐다 — 36회 중 32회이고 진짜 집계는 0건이었다. 집계 경로는 근거를 별도 Cypher 로 다시
// 모으므로 LLM 호출이 한 번 더 늘고 지연이 44초에서 78초로 올랐다.
test('collect 만 쓴 질의를 집계로 판정하지 않는다', () => {
  const { isAggregationCypher } = require('../dist/query/query.service');
  const folded =
    'MATCH (t:Task) WHERE t.number IN [483, 494] OPTIONAL MATCH (t)-[:HAS_COMMENT]->(c:Comment) ' +
    'WITH t, collect(DISTINCT c)[..4] AS comments RETURN t, comments LIMIT 50';
  assert.equal(isAggregationCypher(folded), false, 'collect 는 집계 신호가 아니다');

  assert.equal(isAggregationCypher('MATCH (t:Task) RETURN count(t)'), true);
  assert.equal(isAggregationCypher('MATCH (t:Task) RETURN max(t.number)'), true);
});

// 실측 회귀다. 남은 회수 실패 6건이 전부 "업무는 근거에 왔는데 그 댓글만 빠졌다" 였다.
// 그 댓글을 LLM 호출 없이 그래프 조회로 채운다.
test('근거에 온 업무의 댓글을 끌어와 합친다', async () => {
  const { QueryService } = require('../dist/query/query.service');
  const { testApiConfig } = require('./helpers/test-config');

  const task = { id: 't-483', label: 'Task', key: '483', display: '483', properties: {} };
  const comment = { id: 'c-1', label: 'Comment', key: 'c-1', display: 'c-1', properties: { excerpt: 'ㄱ' } };
  const link = { id: 'r-1', type: 'HAS_COMMENT', startId: 't-483', endId: 'c-1', properties: {} };

  const neo4jService = {
    async executeRead() {
      return { nodes: [], relationships: [] }; // 관계 재조회는 빈 결과
    },
  };
  const service = new QueryService(neo4jService, { async complete() {} }, testApiConfig());
  let asked = null;
  service.fetchTaskComments = async (nodes) => {
    asked = nodes.map((node) => node.id);
    return { nodes: [comment], relationships: [link] };
  };

  const evidence = await service.buildQueryEvidence({ nodes: [task], relationships: [] }, { nodes: [], relationships: [] }, []);

  assert.deepEqual(asked, ['t-483'], '근거에 온 업무를 넘긴다');
  assert.ok(
    evidence.nodes.some((node) => node.id === 'c-1'),
    '끌어온 댓글이 근거에 남는다',
  );
});
