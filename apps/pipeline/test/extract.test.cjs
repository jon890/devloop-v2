const assert = require('node:assert/strict');
const { chmod, cp, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConceptDictionarySchema, OntologyNodeSchema, OntologyRelationshipSchema } = require('@devloop/shared');
const { ClaudeCliAdapter } = require('../dist/llm/claude-cli.adapter');
const { CodexCliAdapter } = require('../dist/llm/codex-cli.adapter');
const { LlmResultSchema } = require('../dist/llm/llm-cli');
const { seedConcepts } = require('../dist/extract/concept-seeder');
const { LlmNodeSchema, LlmRelationshipSchema } = require('../dist/extract/llm-extraction.schema');
const { extractLlm } = require('../dist/extract/llm-extractor');
const { extractStructural } = require('../dist/extract/structural-extractor');

async function fixtureDataRoot() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'wp2-extract-test-'));
  const dataRoot = path.join(temporary, 'data');
  await cp(path.join(__dirname, 'fixtures'), dataRoot, { recursive: true });
  return dataRoot;
}

async function jsonLines(filePath) {
  const content = await readFile(filePath, 'utf8');
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function sourceDocument(prompt) {
  const match = prompt.match(/Source document:\n(\{.*\})\n\nReturn the required JSON object now\./s);
  assert.ok(match, 'prompt contains the serialized source document');
  return JSON.parse(match[1]);
}

function mockExtraction(document) {
  const sourceDocId = document.sourceDocId;
  const sourceKey = `${document.label}:${document.key}`;
  const conceptName = document.label === 'Wiki' ? `Wiki concept ${document.key}` : `Task concept ${document.key}`;
  const nodes = [{
    label: 'Concept',
    key: conceptName,
    properties: { name: conceptName, kind: 'component', sourceDocId },
  }];
  const relationships = [{
    type: 'MENTIONS',
    startKey: sourceKey,
    endKey: `Concept:${conceptName}`,
    properties: { sourceDocId },
  }];
  if (document.label === 'Wiki') {
    relationships.push({
      type: 'DOCUMENTS',
      startKey: sourceKey,
      endKey: `Concept:${conceptName}`,
      properties: { sourceDocId },
    });
  }
  if (sourceDocId === 'Task:102') {
    nodes.push({
      label: 'Decision',
      key: '102-1',
      properties: { id: '102-1', summary: 'Redis 기반 재처리를 적용한다', sourceDocId },
    });
    relationships.push(
      { type: 'DECIDED_IN', startKey: 'Decision:102-1', endKey: 'Task:102', properties: { sourceDocId } },
      { type: 'EVIDENCED_BY', startKey: 'Decision:102-1', endKey: 'Comment:c-102-1', properties: { sourceDocId } },
      { type: 'AFFECTS', startKey: 'Decision:102-1', endKey: `Concept:${conceptName}`, properties: { sourceDocId } },
      { type: 'RELATES_TO', startKey: 'Task:102', endKey: 'Task:101', properties: { kind: 'follows-up', sourceDocId } },
    );
  }
  if (sourceDocId === 'Task:103') {
    const dependency = 'Redis';
    nodes.push({ label: 'Concept', key: dependency, properties: { name: dependency, kind: 'tech', sourceDocId } });
    relationships.push({
      type: 'DEPENDS_ON',
      startKey: `Concept:${conceptName}`,
      endKey: `Concept:${dependency}`,
      properties: { sourceDocId },
    });
  }
  return { nodes, relationships };
}

test('fixture 5건을 온톨로지 구조 노드와 관계로 추출한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const result = await extractStructural({ dataRoot, project: 'tc-ocr' });
  assert.equal(result.outputPath, path.join(dataRoot, 'graph', 'tc-ocr', 'structural.jsonl'));
  const records = await jsonLines(result.outputPath);
  const nodes = records.filter((record) => 'label' in record).map((record) => OntologyNodeSchema.parse(record));
  const relationships = records.filter((record) => 'type' in record).map((record) => OntologyRelationshipSchema.parse(record));
  assert.deepEqual(new Set(nodes.map((node) => node.label)), new Set(['Project', 'Task', 'Wiki', 'Person', 'Comment', 'Concept']));
  assert.deepEqual(
    new Set(relationships.map((relationship) => relationship.type)),
    new Set(['CONTAINS', 'ASSIGNED_TO', 'AUTHORED', 'COMMENTED', 'HAS_COMMENT', 'TAGGED', 'REFERENCES', 'CHILD_OF']),
  );
  assert.ok(nodes.some((node) => node.label === 'Concept' && node.key === 'RetryComponent:18' && node.properties.kind === 'code-ref'));
  assert.ok(nodes.some((node) => node.label === 'Concept' && node.key === 'GatewayInterceptor:77' && node.properties.kind === 'code-ref'));
  assert.ok(relationships.some((relationship) => relationship.type === 'REFERENCES' && relationship.startKey === 'Task:102' && relationship.endKey === 'Task:101'));
  assert.ok(relationships.filter((relationship) => relationship.type === 'TAGGED').every((relationship) => typeof relationship.properties.dimension === 'string'));
});

test('태그·위키 핵심 명사·업무 prefix로 Concept 사전을 시드한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const result = await seedConcepts({ dataRoot, project: 'tc-ocr' });
  const concepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(result.outputPath, 'utf8')));
  assert.ok(concepts.some((entry) => entry.canonical === 'OCR API'));
  assert.ok(concepts.some((entry) => entry.canonical === '아키텍처'));
  assert.ok(concepts.some((entry) => entry.canonical === 'OCR.Console' && entry.aliases.includes('Console')));
});

test('fixture 문서 5건을 문서당 1회, 동시 4개 이하로 LLM 추출하고 캐시한다', async () => {
  const dataRoot = await fixtureDataRoot();
  await seedConcepts({ dataRoot, project: 'tc-ocr' });
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const llm = {
    async complete(prompt) {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      assert.match(prompt, /Fixed ontology:/);
      assert.match(prompt, /Few-shot example:/);
      assert.match(prompt, /Allowed Concept dictionary:/);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { text: JSON.stringify(mockExtraction(sourceDocument(prompt))), elapsedMs: 5 };
    },
  };
  const first = await extractLlm({ dataRoot, project: 'tc-ocr', model: 'mock-model', llm, retryDelayMs: 0 });
  assert.equal(first.documents, 5);
  assert.equal(first.processed, 5);
  assert.equal(first.failed.length, 0);
  assert.equal(calls, 5);
  assert.ok(maximumActive <= 4);
  assert.ok(maximumActive > 1);
  const records = await jsonLines(first.outputPath);
  for (const record of records) {
    if ('label' in record) LlmNodeSchema.parse(record);
    else LlmRelationshipSchema.parse(record);
    assert.ok(record.properties.sourceDocId);
  }
  assert.deepEqual(
    new Set(records.filter((record) => 'type' in record).map((record) => record.type)),
    new Set(['MENTIONS', 'DOCUMENTS', 'DECIDED_IN', 'EVIDENCED_BY', 'AFFECTS', 'RELATES_TO', 'DEPENDS_ON']),
  );
  const second = await extractLlm({
    dataRoot,
    project: 'tc-ocr',
    model: 'mock-model',
    llm: { complete: async () => { throw new Error('cache miss'); } },
    retryDelayMs: 0,
  });
  assert.equal(second.cacheHits, 5);
  assert.equal(second.calls, 0);
});

test('docFilter에 지정한 sourceDocId 문서만 LLM 추출한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const extractedDocIds = [];
  const llm = {
    async complete(prompt) {
      const document = sourceDocument(prompt);
      extractedDocIds.push(document.sourceDocId);
      return { text: JSON.stringify(mockExtraction(document)), elapsedMs: 1 };
    },
  };

  const result = await extractLlm({
    dataRoot,
    project: 'tc-ocr',
    model: 'filtered-model',
    llm,
    docFilter: ['Task:102', 'Wiki:201'],
    retryDelayMs: 0,
  });

  assert.equal(result.documents, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.calls, 2);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(new Set(extractedDocIds), new Set(['Task:102', 'Wiki:201']));
  const records = await jsonLines(result.outputPath);
  assert.deepEqual(
    new Set(records.map((record) => record.properties.sourceDocId)),
    new Set(['Task:102', 'Wiki:201']),
  );
});

test('JSON 파싱 실패는 한 번만 교정 요청한다', async () => {
  const dataRoot = await fixtureDataRoot();
  let calls = 0;
  let repaired = false;
  const llm = {
    async complete(prompt) {
      calls += 1;
      const document = sourceDocument(prompt);
      if (!repaired) {
        repaired = true;
        return { text: 'not json', elapsedMs: 1 };
      }
      return { text: JSON.stringify(mockExtraction(document)), elapsedMs: 1 };
    },
  };
  const result = await extractLlm({ dataRoot, project: 'tc-ocr', model: 'repair-model', llm, retryDelayMs: 0 });
  assert.equal(result.failed.length, 0);
  assert.equal(calls, 6);
});

test('CLI 실패는 문서별 최대 3회 후 실패 목록에 기록한다', async () => {
  const dataRoot = await fixtureDataRoot();
  let calls = 0;
  const result = await extractLlm({
    dataRoot,
    project: 'tc-ocr',
    model: 'failure-model',
    llm: { complete: async () => { calls += 1; throw new Error('rate limited'); } },
    maxAttempts: 3,
    retryDelayMs: 0,
  });
  assert.equal(calls, 15);
  assert.equal(result.failed.length, 5);
  assert.deepEqual(JSON.parse(await readFile(result.failureReportPath, 'utf8')), result.failed);
});

test('Codex·Claude CLI 어댑터가 고정 인자와 elapsedMs 계약을 지킨다', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'wp2-cli-test-'));
  const argsFile = path.join(temporary, 'args.json');
  const codexPath = path.join(temporary, 'codex');
  const claudePath = path.join(temporary, 'claude');
  await writeFile(codexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.WP2_ARGS_FILE, JSON.stringify(args));
const outputIndex = args.indexOf('--output-last-message');
fs.writeFileSync(args[outputIndex + 1], '{"nodes":[],"relationships":[]}');
`, 'utf8');
  await writeFile(claudePath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.WP2_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: input, usage: { input_tokens: 2, output_tokens: 3 } })));
`, 'utf8');
  await Promise.all([chmod(codexPath, 0o755), chmod(claudePath, 0o755)]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${temporary}:${previousPath}`;
  process.env.WP2_ARGS_FILE = argsFile;
  try {
    const codex = LlmResultSchema.parse(await new CodexCliAdapter().complete('codex prompt', { model: 'codex-model' }));
    assert.equal(codex.text, '{"nodes":[],"relationships":[]}');
    const codexArgs = JSON.parse(await readFile(argsFile, 'utf8'));
    assert.deepEqual(codexArgs.slice(0, 5), ['exec', '--sandbox', 'read-only', '--ephemeral', '--output-last-message']);
    assert.match(codexArgs[5], /devloop-codex-.+\/last-message\.json$/);
    assert.deepEqual(codexArgs.slice(6), ['-m', 'codex-model', 'codex prompt']);

    const claude = LlmResultSchema.parse(await new ClaudeCliAdapter().complete('claude prompt', { model: 'claude-model' }));
    assert.equal(claude.text, 'claude prompt');
    assert.deepEqual(claude.tokens, { in: 2, out: 3 });
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      '-p', '--output-format', 'json', '--model', 'claude-model',
    ]);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.WP2_ARGS_FILE;
  }
});
