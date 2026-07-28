// 이 require 는 반드시 첫 줄이어야 한다. dist/app.module 이 로드되기 전에
// 테스트 DB 를 고정하지 않으면 앱이 루트 .env 의 운영 개발 DB(7687)를 물고 뜬다.
const { applyE2eEnv, assertTestDatabaseUri } = require('./helpers/e2e-env');

const testDatabaseUri = applyE2eEnv();

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const { resolve } = require('node:path');
const { Test } = require('@nestjs/testing');
const neo4j = require('neo4j-driver');
const {
  GraphSearchResponseSchema,
  GraphSamplesResponseSchema,
  GraphStatsResponseSchema,
  NeighborsResponseSchema,
  OntologyResponseSchema,
  QueryResponseSchema,
} = require('@devloop/shared');
const { AppModule } = require('../dist/app.module');
const { API_CONFIG } = require('../dist/config');
const { LLM_CLI } = require('../dist/llm-cli');

const repoRoot = resolve(__dirname, '../../..');
const fixtureDir = resolve(__dirname, 'fixtures');

class MockLlmCli {
  constructor() {
    this.prompts = [];
    this.options = [];
    this.responses = [];
  }

  enqueue(...responses) {
    this.responses.push(...responses);
  }

  async complete(prompt, options) {
    this.prompts.push(prompt);
    this.options.push(options);
    const text = this.responses.shift();
    assert.notEqual(text, undefined, `Unexpected LlmCli call:\n${prompt}`);
    return { text, elapsedMs: 1 };
  }
}

let app;
let baseUrl;
let driver;
let mockLlm;
let loadOutput;
let resolvedApiConfig;

before(async () => {
  assertTestDatabaseUri(testDatabaseUri);

  driver = neo4j.driver(
    testDatabaseUri,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
  );
  await driver.verifyConnectivity();

  const cleanupSession = driver.session({ database: 'neo4j' });
  try {
    await cleanupSession.run('MATCH (n) DETACH DELETE n');
  } finally {
    await cleanupSession.close();
  }

  const commandEnv = { ...process.env };
  execFileSync('pnpm', ['--filter', 'pipeline', 'schema:apply'], {
    cwd: repoRoot,
    env: commandEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  loadOutput = execFileSync(
    'pnpm',
    ['--filter', 'pipeline', 'load', '--project', 'e2e', '--data-dir', fixtureDir],
    {
      cwd: repoRoot,
      env: commandEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const secondLoadOutput = execFileSync(
    'pnpm',
    ['--filter', 'pipeline', 'load', '--project', 'e2e', '--data-dir', fixtureDir],
    {
      cwd: repoRoot,
      env: commandEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.match(loadOutput, /"nodes": 25/);
  assert.match(loadOutput, /"relationships": 39/);
  assert.match(loadOutput, /"새 도메인": 1/);
  assert.match(secondLoadOutput, /"nodes": 25/);
  assert.match(secondLoadOutput, /"relationships": 39/);

  const refreshSession = driver.session({ database: 'neo4j' });
  try {
    await refreshSession.run('CALL db.index.fulltext.awaitEventuallyConsistentIndexRefresh()');
  } finally {
    await refreshSession.close();
  }

  mockLlm = new MockLlmCli();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LLM_CLI)
    .useValue(mockLlm)
    .compile();

  // 앱이 실제로 무엇을 물고 떴는지 확인한 뒤에만 기동한다.
  // 설정이 운영 개발 DB 를 가리키면 요청을 한 건도 보내기 전에 여기서 멈춘다.
  resolvedApiConfig = moduleRef.get(API_CONFIG);
  assertTestDatabaseUri(resolvedApiConfig.neo4j.uri);
  assert.equal(resolvedApiConfig.neo4j.uri, testDatabaseUri);

  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.equal(typeof address, 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (app) await app.close();
  if (driver) await driver.close();
});

async function jsonRequest(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  assert.ok(response.ok, `${response.status} ${JSON.stringify(body)}`);
  return body;
}

test('schema, idempotent load, stats, fulltext search, and neighbors satisfy the contract', async () => {
  const schemaSession = driver.session({
    database: 'neo4j',
    defaultAccessMode: neo4j.session.READ,
  });
  try {
    const constraints = await schemaSession.run(
      'SHOW CONSTRAINTS YIELD type WHERE type = "UNIQUENESS" RETURN count(*) AS count',
    );
    assert.equal(constraints.records[0].get('count').toNumber(), 7);
    const indexes = await schemaSession.run(
      'SHOW FULLTEXT INDEXES YIELD name, options RETURN name, options ORDER BY name',
    );
    assert.deepEqual(
      indexes.records.map((record) => record.get('name')),
      ['concept_name_fulltext', 'task_subject_fulltext', 'wiki_subject_fulltext'],
    );
    for (const record of indexes.records) {
      assert.equal(record.get('options').indexConfig['fulltext.analyzer'], 'cjk');
    }
  } finally {
    await schemaSession.close();
  }

  const stats = GraphStatsResponseSchema.parse(await jsonRequest('/api/graph/stats'));
  assert.deepEqual(stats.nodes, {
    Comment: 4,
    Concept: 5,
    Decision: 4,
    Person: 3,
    Project: 1,
    Task: 6,
    Wiki: 2,
  });
  assert.equal(stats.relationships.CONTAINS, 8);
  assert.equal(Object.values(stats.relationships).reduce((sum, count) => sum + count, 0), 39);
  assert.equal(stats.relationships.RELATES_TO, 3);

  const ontology = OntologyResponseSchema.parse(await jsonRequest('/api/ontology'));
  assert.equal(ontology.nodes.length, 7);
  assert.equal(ontology.relationships.length, 15);

  const taskSamples = GraphSamplesResponseSchema.parse(
    await jsonRequest('/api/graph/samples?label=Task'),
  );
  assert.equal(taskSamples.nodes.length, 5);
  assert.ok(taskSamples.nodes.every((node) => node.label === 'Task'));

  const decisionSamples = GraphSamplesResponseSchema.parse(
    await jsonRequest('/api/graph/samples?relationship=DECIDED_IN'),
  );
  assert.equal(decisionSamples.relationships.length, 4);
  assert.ok(
    decisionSamples.relationships.every((relationship) => relationship.type === 'DECIDED_IN'),
  );

  const search = GraphSearchResponseSchema.parse(
    await jsonRequest(`/api/graph/search?q=${encodeURIComponent('Graph API')}`),
  );
  assert.ok(search.some((node) => node.label === 'Concept' && node.key === 'Graph API'));
  assert.ok(search.some((node) => node.label === 'Task' && node.key === '105'));

  const canonicalSearch = GraphSearchResponseSchema.parse(
    await jsonRequest(`/api/graph/search?q=${encodeURIComponent('General OCR')}`),
  );
  assert.ok(canonicalSearch.some((node) => node.label === 'Concept' && node.key === 'General OCR'));
  assert.ok(canonicalSearch.every((node) => node.key !== 'OCR 모델'));

  const graphApi = search.find((node) => node.label === 'Concept' && node.key === 'Graph API');
  const neighbors = NeighborsResponseSchema.parse(
    await jsonRequest(`/api/graph/nodes/${encodeURIComponent(graphApi.id)}/neighbors?depth=1`),
  );
  assert.ok(neighbors.nodes.some((node) => node.id === graphApi.id));
  assert.ok(neighbors.nodes.some((node) => node.key === 'NestJS'));
  assert.ok(neighbors.relationships.some((relationship) => relationship.type === 'DEPENDS_ON'));

  const excessiveDepth = await fetch(
    `${baseUrl}/api/graph/nodes/${encodeURIComponent(graphApi.id)}/neighbors?depth=6`,
  );
  assert.equal(excessiveDepth.status, 400);
});

test('query executes anchor, Cypher, and synthesis stages with a mock LlmCli', async () => {
  mockLlm.enqueue(
    JSON.stringify({ terms: ['General OCR'] }),
    JSON.stringify({
      cypher:
        "MATCH (t:Task)-[:MENTIONS]->(:Concept {name: 'General OCR'}) RETURN t LIMIT 10",
    }),
    JSON.stringify({ answer: 'General OCR는 업무 101에서 언급됐습니다.' }),
  );

  const response = QueryResponseSchema.parse(
    await jsonRequest('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'General OCR와 관련된 업무는?' }),
    }),
  );
  assert.equal(response.answer, 'General OCR는 업무 101에서 언급됐습니다.');
  assert.match(response.cypher, /MATCH \(t:Task\)/);
  assert.ok(response.evidence.nodes.some((node) => node.key === '101'));
  assert.ok(response.evidence.nodes.some((node) => node.key === 'General OCR'));
  assert.ok(response.evidence.relationships.some((relationship) => relationship.type === 'MENTIONS'));
  assert.deepEqual(response.evidence.nodes.map((node) => node.label), ['Task', 'Concept']);

  const prompts = mockLlm.prompts.slice(-3);
  const options = mockLlm.options.slice(-3);
  assert.ok(options.every((option) => option.model === 'query-test-model'));
  assert.match(prompts[0], /fulltext/);
  assert.match(prompts[1], /Task: number\(int\), subject, workflowClass, createdAt/);
  assert.match(prompts[1], /Wiki: pageId, subject, parentId/);
  assert.match(prompts[1], /ASSIGNED_TO: Task -> Person/);
  assert.match(prompts[1], /CHILD_OF: Task -> Task; Wiki -> Wiki/);
  assert.match(prompts[1], /fulltext 검색으로 이미 찾은 anchor를 우선/);
  assert.match(prompts[1], /"label":"Concept","key":"General OCR","display":"General OCR"/);
  assert.match(prompts[2], /Evidence:/);
});

test('query prompt exposes Wiki subject and fulltext anchor identity', async () => {
  const promptStart = mockLlm.prompts.length;
  mockLlm.enqueue(
    JSON.stringify({ terms: ['Graph API'] }),
    JSON.stringify({
      cypher: "MATCH (w:Wiki) WHERE w.subject CONTAINS 'Graph API' RETURN w LIMIT 50",
    }),
    JSON.stringify({ answer: '제목에 Graph API가 들어간 위키를 찾았습니다.' }),
  );

  // 질의 모델은 기동 시점 설정으로 고정된다. 실행 중 환경변수를 지워도 바뀌지 않는다.
  delete process.env.QUERY_LLM_MODEL;
  const response = QueryResponseSchema.parse(
    await jsonRequest('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '제목에 Graph API가 들어가는 Wiki' }),
    }),
  );
  process.env.QUERY_LLM_MODEL = 'query-test-model';

  assert.equal(response.answer, '제목에 Graph API가 들어간 위키를 찾았습니다.');
  assert.match(response.cypher, /w\.subject CONTAINS/);
  const generationPrompt = mockLlm.prompts[promptStart + 1];
  assert.match(generationPrompt, /Wiki: pageId, subject, parentId/);
  assert.doesNotMatch(generationPrompt, /Wiki:.*\btitle\b/);
  assert.match(generationPrompt, /"label":"Wiki","key":"wiki-2","display":"Graph API operation guide"/);
  assert.deepEqual(response.evidence.nodes.map((node) => node.label), ['Wiki', 'Concept']);
  assert.ok(response.evidence.nodes.every((node) => node.label !== 'Task'));
  assert.ok(
    mockLlm.options
      .slice(promptStart, promptStart + 3)
      .every((option) => option.model === 'query-test-model'),
  );
});

test('query regenerates Cypher exactly once after an execution error', async () => {
  const promptStart = mockLlm.prompts.length;
  mockLlm.enqueue(
    JSON.stringify({ terms: ['Graph API'] }),
    JSON.stringify({ cypher: 'MATCH (n RETURN n' }),
    JSON.stringify({
      cypher:
        "MATCH (t:Task)-[r:TAGGED]->(c:Concept) WHERE c.name = 'Graph API' RETURN t, r, c LIMIT 10",
    }),
    JSON.stringify({ answer: 'Graph API는 업무 101에 태그되었습니다.' }),
  );

  const response = QueryResponseSchema.parse(
    await jsonRequest('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Graph API 태그 업무는?' }),
    }),
  );
  assert.equal(response.answer, 'Graph API는 업무 101에 태그되었습니다.');
  assert.match(response.cypher, /TAGGED/);
  const prompts = mockLlm.prompts.slice(promptStart);
  assert.equal(prompts.length, 4);
  assert.match(prompts[2], /Previous: MATCH \(n RETURN n/);
  assert.match(prompts[2], /Error:/);
});

test('query retries a malformed structured LLM response once', async () => {
  const promptStart = mockLlm.prompts.length;
  mockLlm.enqueue(
    'not-json',
    JSON.stringify({ terms: ['Neo4j'] }),
    JSON.stringify({ cypher: "MATCH (c:Concept) WHERE c.name = 'Neo4j' RETURN c LIMIT 10" }),
    JSON.stringify({ answer: 'Neo4j 개념을 찾았습니다.' }),
  );

  const response = QueryResponseSchema.parse(
    await jsonRequest('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Neo4j 개념을 찾아줘' }),
    }),
  );
  assert.equal(response.answer, 'Neo4j 개념을 찾았습니다.');
  const prompts = mockLlm.prompts.slice(promptStart);
  assert.equal(prompts.length, 4);
  assert.match(prompts[1], /Previous response: not-json/);
  assert.match(prompts[1], /Validation error:/);
});

test('query returns a non-empty diagnostic and attempted fallback Cypher when generation fails', async () => {
  mockLlm.enqueue(
    JSON.stringify({ terms: ['장애'] }),
    JSON.stringify({ cypher: null }),
    JSON.stringify({ cypher: null }),
  );

  const response = QueryResponseSchema.parse(
    await jsonRequest('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '유형 태그가 장애인 Task를 제품별 집계' }),
    }),
  );

  assert.ok(response.answer.trim().length > 0);
  assert.match(response.answer, /Cypher 생성/);
  assert.ok(response.cypher.trim().length > 0);
  assert.match(response.cypher, /^MATCH/);
});

test('query keeps all aggregate rows and collects evidence with a separate Cypher', async () => {
  const promptStart = mockLlm.prompts.length;
  const aggregateCypher =
    'MATCH (p:Person)<-[:ASSIGNED_TO]-(t:Task) ' +
    'RETURN p.name AS person, count(t) AS taskCount ORDER BY taskCount DESC, person LIMIT 5';
  const evidenceCypher =
    'MATCH (p:Person)<-[r:ASSIGNED_TO]-(t:Task) RETURN p, r, t LIMIT 50';
  mockLlm.enqueue(
    JSON.stringify({ terms: ['담당 Task'] }),
    JSON.stringify({ cypher: aggregateCypher }),
    JSON.stringify({ cypher: evidenceCypher }),
    JSON.stringify({ answer: 'Alice와 Bob이 각각 1건을 담당합니다.' }),
  );

  const response = QueryResponseSchema.parse(
    await jsonRequest('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Person 별 담당 Task 수 상위 5명' }),
    }),
  );

  assert.equal(response.cypher, aggregateCypher);
  assert.equal(response.answer, 'Alice와 Bob이 각각 1건을 담당합니다.');
  assert.ok(response.evidence.nodes.some((node) => node.key === 'member-1'));
  assert.ok(response.evidence.nodes.some((node) => node.key === 'member-2'));
  const prompts = mockLlm.prompts.slice(promptStart);
  assert.match(prompts[1], /집계 결과 행만 반환/);
  assert.match(prompts[2], /근거 수집 전용/);
  assert.match(prompts[3], /"person":"Alice"/);
  assert.match(prompts[3], /"person":"Bob"/);
});

test('query falls back to a non-empty answer when answer synthesis stays blank', async () => {
  const cypher = "MATCH (c:Concept) WHERE c.name = 'missing' RETURN c LIMIT 10";
  mockLlm.enqueue(
    JSON.stringify({ terms: ['missing'] }),
    JSON.stringify({ cypher }),
    JSON.stringify({ answer: '' }),
    JSON.stringify({ answer: '   ' }),
  );

  const response = QueryResponseSchema.parse(
    await jsonRequest('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '없는 개념을 찾아줘' }),
    }),
  );

  assert.ok(response.answer.trim().length > 0);
  assert.match(response.answer, /결과를 찾지 못했습니다/);
  assert.equal(response.cypher, cypher);
});

test('기동한 API는 운영 개발 DB가 아니라 테스트 DB에만 접속한다', () => {
  assert.equal(resolvedApiConfig.neo4j.uri, testDatabaseUri);
  assertTestDatabaseUri(resolvedApiConfig.neo4j.uri);
  assert.equal(new URL(resolvedApiConfig.neo4j.uri).port, '7688');
  assert.equal(resolvedApiConfig.neo4j.password, 'devloop-test-password');
});
