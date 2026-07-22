const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const { resolve } = require('node:path');
const { Test } = require('@nestjs/testing');
const neo4j = require('neo4j-driver');
const {
  GraphSearchResponseSchema,
  GraphStatsResponseSchema,
  NeighborsResponseSchema,
  QueryResponseSchema,
} = require('@devloop/shared');
const { AppModule } = require('../dist/app.module');
const { LLM_CLI } = require('../dist/llm-cli');

const repoRoot = resolve(__dirname, '../../..');
const fixtureDir = resolve(__dirname, 'fixtures');

class MockLlmCli {
  constructor() {
    this.prompts = [];
    this.responses = [];
  }

  enqueue(...responses) {
    this.responses.push(...responses);
  }

  async complete(prompt) {
    this.prompts.push(prompt);
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

before(async () => {
  process.env.NEO4J_URI ??= 'bolt://localhost:7687';
  process.env.NEO4J_USER ??= 'neo4j';
  process.env.NEO4J_PASSWORD ??= 'devloop-password';

  driver = neo4j.driver(
    process.env.NEO4J_URI,
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
        "MATCH (t:Task)-[r:MENTIONS]->(c:Concept) WHERE c.name = 'General OCR' RETURN t, r, c LIMIT 10",
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

  const prompts = mockLlm.prompts.slice(-3);
  assert.match(prompts[0], /fulltext/);
  assert.match(prompts[1], /Anchor nodes:/);
  assert.match(prompts[1], /Ontology nodes:/);
  assert.match(prompts[2], /Evidence:/);
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
