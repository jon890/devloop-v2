const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chmod, cp, mkdir, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConceptDictionarySchema, OntologyNodeSchema, OntologyRelationshipSchema } = require('@devloop/shared');
const { ClaudeCliAdapter } = require('../dist/llm/claude-cli.adapter');
const { CodexCliAdapter } = require('../dist/llm/codex-cli.adapter');
const { LlmResultSchema } = require('../dist/llm/llm-cli');
const { removeConflictingAliases, seedConcepts } = require('../dist/concepts/concept-seeder');
const { normalizeConceptKey } = require('@devloop/shared');
const { LlmNodeSchema, LlmRelationshipSchema } = require('../dist/infer/llm-extraction.schema');
const { extractLlm: extractLlmWithRegistry } = require('../dist/infer/llm-extractor');
const { sanitizeLlmGraphFile } = require('../dist/infer/llm-relationship-sanitizer');
const { extractStructural } = require('../dist/parse/structural-extractor');
const { COMMENT_EXCERPT_LIMIT, TASK_BODY_LIMIT } = require('../dist/parse/parse.const');
const { resolvePipelineDataRoot } = require('../dist/main');

const extractLlm = (options) => extractLlmWithRegistry({ ...options, curation: { merges: [], blocks: [] } });

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
  const postPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '101.json');
  const post = JSON.parse(await readFile(postPath, 'utf8'));
  post.post.body.content += '\n외부 작업 external-project/999999';
  await writeFile(postPath, JSON.stringify(post));
  const childWikiPath = path.join(dataRoot, 'raw', 'tc-ocr', 'wiki', '202.json');
  const childWiki = JSON.parse(await readFile(childWikiPath, 'utf8'));
  childWiki.parentPageId = childWiki.parentId;
  delete childWiki.parentId;
  await writeFile(childWikiPath, JSON.stringify(childWiki));
  const result = await extractStructural({ dataRoot, project: 'tc-ocr' });
  assert.equal(result.outputPath, path.join(dataRoot, 'graph', 'tc-ocr', 'parsed.jsonl'));
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
  assert.equal(relationships.some((relationship) => relationship.endKey === 'Task:999999'), false);
  const taskReferences = relationships.filter((relationship) => relationship.type === 'REFERENCES');
  assert.equal(taskReferences.some((relationship) => relationship.startKey === relationship.endKey), false, '자기참조는 REFERENCES 로 만들지 않는다');
  assert.equal(taskReferences.some((relationship) => relationship.properties.project === 'pull'), false, 'GitHub URL 조각은 REFERENCES 로 만들지 않는다');
  assert.deepEqual(new Set(taskReferences.map((relationship) => relationship.properties.project)), new Set(['tc-ocr']), '추출 대상과 다른 프로젝트 참조는 REFERENCES 로 만들지 않는다');
  assert.ok(relationships.some((relationship) =>
    relationship.type === 'CHILD_OF' &&
    relationship.startKey === 'Wiki:202' &&
    relationship.endKey === 'Wiki:201'));
  assert.equal(relationships.some((relationship) =>
    relationship.type === 'CHILD_OF' &&
    relationship.startKey.startsWith('Wiki:') &&
    relationship.endKey === 'Wiki:0'), false);
  assert.ok(relationships.filter((relationship) => relationship.type === 'TAGGED').every((relationship) => typeof relationship.properties.dimension === 'string'));
});

test('Task bodyExcerpt는 raw 마크다운과 개행을 유지하고 상한까지 저장한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const postPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '101.json');
  const document = JSON.parse(await readFile(postPath, 'utf8'));
  const rawBody = [
    '## 개요',
    '',
    '* API Gateway를 제거한 이유를 기록한다.',
    '',
    `후속 내용 ${'가'.repeat(TASK_BODY_LIMIT + 20)}`,
  ].join('\n');
  document.post.body.content = rawBody;
  await writeFile(postPath, JSON.stringify(document));

  const result = await extractStructural({ dataRoot, project: 'tc-ocr' });
  const records = await jsonLines(result.outputPath);
  const task = records.find((record) => record.label === 'Task' && record.key === '101');

  assert.equal(task.properties.bodyExcerpt, rawBody.slice(0, TASK_BODY_LIMIT));
  assert.equal(task.properties.bodyExcerpt.length, TASK_BODY_LIMIT);
  assert.match(task.properties.bodyExcerpt, /^## 개요\n\n\* API Gateway/);
  assert.equal(result.truncatedTaskBodies, 1, '상한을 넘긴 본문 1건이 요약에 집계된다');
});

// phase-01 이 1번 위험으로 못 박은 자리다. 훅 머리말 벗기기나 개행 보존 추출이
// addCommentNode 밖으로 올라가면 addTextReferences 가 가공된 값을 받아 REFERENCES 가 조용히 바뀐다.
// 참조를 머리말 둘째 줄에만 두어, 유출이 생기면 이 테스트가 반드시 실패하게 만든다.
test('업무 참조 추출은 훅 머리말을 벗기지 않은 원문을 받는다', async () => {
  const dataRoot = await fixtureDataRoot();
  const postPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '101.json');
  const document = JSON.parse(await readFile(postPath, 'utf8'));
  const repo = '[[TOASTCloud/OCR.Console](https://github.nhnent.com/TOASTCloud/OCR.Console)]';
  const commit = '[62d7fab](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/62d7fab)';
  document.comments[0].content = [
    `${repo} dev pushes ${commit} to \`refs/heads/develop\``,
    '[관련 업무 tc-ocr/102 대응](https://github.nhnent.com/x/y/pull/9)',
    '본문에는 참조가 없다',
  ].join('\n');
  await writeFile(postPath, JSON.stringify(document));

  const result = await extractStructural({ dataRoot, project: 'tc-ocr' });
  const records = await jsonLines(result.outputPath);
  const comment = records.find((record) => record.label === 'Comment' && record.key === 'c-101-1');

  assert.equal(comment.properties.excerpt, '본문에는 참조가 없다', '저장 값은 머리말이 벗겨진다');
  assert.ok(
    records.some(
      (record) => record.type === 'REFERENCES' && record.startKey === 'Task:101' && record.endKey === 'Task:102',
    ),
    '머리말 둘째 줄의 참조가 REFERENCES 로 남아야 한다 — 없으면 가공된 값이 참조 추출로 새어나갔다',
  );
});

test('상한을 넘긴 댓글 건수가 요약에 집계된다', async () => {
  const dataRoot = await fixtureDataRoot();
  const postPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '101.json');
  const document = JSON.parse(await readFile(postPath, 'utf8'));
  document.comments[0].content = '다'.repeat(COMMENT_EXCERPT_LIMIT + 100);
  await writeFile(postPath, JSON.stringify(document));

  const result = await extractStructural({ dataRoot, project: 'tc-ocr' });
  const records = await jsonLines(result.outputPath);
  const comment = records.find((record) => record.label === 'Comment' && record.key === 'c-101-1');

  assert.equal(comment.properties.excerpt.length, COMMENT_EXCERPT_LIMIT);
  assert.equal(result.truncatedComments, 1);
});

test('상한 이하 본문은 잘리지 않고 집계에도 오르지 않는다', async () => {
  const dataRoot = await fixtureDataRoot();
  const postPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '101.json');
  const document = JSON.parse(await readFile(postPath, 'utf8'));
  const rawBody = `후속 내용 ${'가'.repeat(1200)}`;
  document.post.body.content = rawBody;
  await writeFile(postPath, JSON.stringify(document));

  const result = await extractStructural({ dataRoot, project: 'tc-ocr' });
  const records = await jsonLines(result.outputPath);
  const task = records.find((record) => record.label === 'Task' && record.key === '101');

  assert.equal(task.properties.bodyExcerpt, rawBody, '기존 300자 상한을 넘는 본문이 온전히 남는다');
  assert.equal(result.truncatedTaskBodies, 0);
});

test('실제 Dooray 구조에서 사람 관계·태그 차원·정수 업무 번호를 추출한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const postPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '101.json');
  const document = JSON.parse(await readFile(postPath, 'utf8'));
  document.post.users = {
    from: {
      type: 'member',
      member: { organizationMemberId: 'm-1', name: '원본 이름은 사용하지 않음' },
    },
    to: [{
      type: 'member',
      member: { organizationMemberId: 'm-2' },
    }],
    cc: [
      { type: 'member', member: { organizationMemberId: 'm-3' } },
      { type: 'member', member: { organizationMemberId: 'm-unknown', name: '미등록 사용자' } },
    ],
  };
  document.post.tags = [{ id: 'tag-product' }];
  document.comments[0].creator = {
    type: 'member',
    member: { organizationMemberId: 'm-3' },
  };
  delete document.comments[0].users;
  await writeFile(postPath, JSON.stringify(document));
  await writeFile(
    path.join(dataRoot, 'raw', 'tc-ocr', 'tags.json'),
    JSON.stringify({
      'tag-type': '0: 장애',
      'tag-product': '1: General OCR',
      'tag-component': '2: API',
    }),
  );

  const result = await extractStructural({ dataRoot, project: 'tc-ocr' });
  const records = await jsonLines(result.outputPath);
  const nodes = records.filter((record) => 'label' in record);
  const relationships = records.filter((record) => 'type' in record);

  const task = nodes.find((node) => node.label === 'Task' && node.key === '101');
  assert.equal(task.properties.number, 101);
  assert.equal(typeof task.properties.number, 'number');
  assert.ok(nodes.filter((node) => node.label === 'Comment').every((node) => typeof node.properties.commentId === 'string'));
  assert.ok(nodes.filter((node) => node.label === 'Wiki').every((node) => typeof node.properties.pageId === 'string'));

  assert.ok(relationships.some((relationship) =>
    relationship.type === 'AUTHORED' &&
    relationship.startKey === 'Person:m-1' &&
    relationship.endKey === 'Task:101'));
  assert.ok(relationships.some((relationship) =>
    relationship.type === 'ASSIGNED_TO' &&
    relationship.startKey === 'Task:101' &&
    relationship.endKey === 'Person:m-2' &&
    relationship.properties.role === 'to'));
  assert.ok(relationships.some((relationship) =>
    relationship.type === 'ASSIGNED_TO' &&
    relationship.startKey === 'Task:101' &&
    relationship.endKey === 'Person:m-3' &&
    relationship.properties.role === 'cc'));
  assert.ok(relationships.some((relationship) =>
    relationship.type === 'COMMENTED' &&
    relationship.startKey === 'Person:m-3' &&
    relationship.endKey === 'Comment:c-101-1'));
  assert.deepEqual(
    new Set(
      relationships
        .filter((relationship) => relationship.type === 'TAGGED')
        .map((relationship) => relationship.properties.dimension),
    ),
    new Set(['0', '1', '2']),
  );

  assert.equal(nodes.find((node) => node.label === 'Person' && node.key === 'm-1').properties.name, '김개발');
  assert.equal(nodes.find((node) => node.label === 'Person' && node.key === 'm-unknown').properties.name, 'm-unknown');
});

test('태그 차원·위키 영문 기술어·업무 prefix로 중복 없는 Concept 사전을 시드한다', async () => {
  const dataRoot = await fixtureDataRoot();
  await writeFile(path.join(dataRoot, 'raw', 'tc-ocr', 'tags.json'), JSON.stringify({
    'tag-component': '2: API',
    'tag-product': '1: General OCR',
    'tag-type': '0: 장애',
  }));
  await writeFile(path.join(dataRoot, 'raw', 'tc-ocr', 'wiki', '203.json'), JSON.stringify({
    pageId: 203,
    subject: 'Log & Crash / NHN Container Service / X-Request-Id 모델까지',
    parentId: 0,
    body: { content: '' },
  }));
  const koreanPrefixPostPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '102.json');
  const koreanPrefixPost = JSON.parse(await readFile(koreanPrefixPostPath, 'utf8'));
  koreanPrefixPost.post.subject = '[배포 Main] 재처리 의존성 정리';
  await writeFile(koreanPrefixPostPath, JSON.stringify(koreanPrefixPost));
  const outputPath = path.join(dataRoot, 'concepts', 'tc-ocr.json');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify([
    { canonical: '감싸나', kind: 'type', aliases: [] },
    { canonical: 'OCR.API', kind: 'tech', aliases: ['API', 'legacy-api', 'shared-alias'] },
    { canonical: 'OCR.API', kind: 'tech', aliases: ['legacy-api-2'] },
    { canonical: 'OCR.Console', kind: 'component', aliases: ['Console', 'shared-alias'] },
    { canonical: 'DocumentIdCardAuthenticityService:82', kind: 'code-ref', aliases: [] },
  ]));

  const result = await seedConcepts({ dataRoot, project: 'tc-ocr', curation: { merges: [], blocks: [] } });
  const concepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(result.outputPath, 'utf8')));
  const byCanonical = new Map(concepts.map((entry) => [entry.canonical, entry]));

  assert.equal(concepts.some((entry) => entry.canonical === 'OCR API'), false);
  assert.equal(byCanonical.has('아키텍처'), false);
  assert.equal(byCanonical.has('모델까지'), false);
  assert.deepEqual(byCanonical.get('장애'), { canonical: '장애', kind: 'type', aliases: ['0: 장애'] });
  assert.deepEqual(byCanonical.get('General OCR'), {
    canonical: 'General OCR',
    kind: 'product',
    aliases: ['1: General OCR'],
  });
  assert.deepEqual(byCanonical.get('OCR.Console'), {
    canonical: 'OCR.Console',
    kind: 'component',
    aliases: ['OCR Console'],
  });
  assert.deepEqual(byCanonical.get('OCR.API'), {
    canonical: 'OCR.API',
    kind: 'tech',
    aliases: ['OCR API', 'legacy-api', 'legacy-api-2'],
  });
  assert.ok(byCanonical.has('Log & Crash'));
  assert.ok(byCanonical.has('NHN Container Service'));
  assert.ok(byCanonical.has('X-Request-Id'));
  assert.equal(concepts.filter((entry) => entry.canonical === 'OCR.API').length, 1);
  assert.equal(byCanonical.has('감싸나'), true);
  assert.equal(byCanonical.has('DocumentIdCardAuthenticityService:82'), true);
  assert.deepEqual(byCanonical.get('배포 Main'), { canonical: '배포 Main', kind: 'component', aliases: [] });
  assert.equal(concepts.some((entry) => /^[012]:\s/.test(entry.canonical)), false);
});

test('판단 alias 는 seed-concepts 재생성 후 canonical 로 되살아나지 않고 alias 로 남는다', async () => {
  const dataRoot = await fixtureDataRoot();
  await writeFile(path.join(dataRoot, 'raw', 'tc-ocr', 'wiki', '203.json'), JSON.stringify({
    pageId: 203,
    subject: 'Gateway / OCR API Gateway',
    parentId: 0,
    body: { content: '' },
  }));

  const result = await seedConcepts({
    dataRoot,
    project: 'tc-ocr',
    curation: {
      merges: [{ canonical: 'OCR API Gateway', aliases: ['Gateway'], reason: 'human judgment' }],
      blocks: [],
    },
  });
  const concepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(result.outputPath, 'utf8')));
  const byCanonical = new Map(concepts.map((entry) => [entry.canonical, entry]));

  assert.equal(byCanonical.has('Gateway'), false);
  assert.ok(byCanonical.get('OCR API Gateway').aliases.includes('Gateway'));
});

test('판단 alias 는 의도된 canonical 만 소유한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const outputPath = path.join(dataRoot, 'concepts', 'tc-ocr.json');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify([
    { canonical: 'Legacy Gateway', kind: 'component', aliases: ['Gateway'] },
  ]));

  const result = await seedConcepts({
    dataRoot,
    project: 'tc-ocr',
    curation: {
      merges: [{ canonical: 'OCR API Gateway', aliases: ['Gateway'], reason: 'human judgment' }],
      blocks: [],
    },
  });
  const concepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(result.outputPath, 'utf8')));
  const byCanonical = new Map(concepts.map((entry) => [entry.canonical, entry]));

  assert.deepEqual(byCanonical.get('Legacy Gateway').aliases, []);
  assert.ok(byCanonical.get('OCR API Gateway').aliases.includes('Gateway'));
});

test('seed-concepts 는 설정과 명시적 판단이 모두 없으면 실패한다', async () => {
  const dataRoot = await fixtureDataRoot();
  await assert.rejects(() => seedConcepts({ dataRoot, project: 'tc-ocr' }), /requires pipeline config/);
});

test('seed-concepts 는 대소문자만 다른 원천 표기보다 기존 canonical 을 유지한다', async () => {
  const dataRoot = await fixtureDataRoot();
  await writeFile(path.join(dataRoot, 'raw', 'tc-ocr', 'wiki', '203.json'), JSON.stringify({
    pageId: 203,
    subject: 'OCR.DOC',
    parentId: 0,
    body: { content: '' },
  }));
  const postPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts', '102.json');
  const post = JSON.parse(await readFile(postPath, 'utf8'));
  post.post.subject = '[OCR.\bAdmin] control character variant';
  await writeFile(postPath, JSON.stringify(post));
  const outputPath = path.join(dataRoot, 'concepts', 'tc-ocr.json');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify([
    { canonical: 'OCR.Doc', kind: 'component', aliases: [] },
    { canonical: 'OCR.Admin', kind: 'component', aliases: [] },
  ]));

  const result = await seedConcepts({ dataRoot, project: 'tc-ocr', curation: { merges: [], blocks: [] } });
  const concepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(result.outputPath, 'utf8')));

  assert.equal(concepts.some((entry) => entry.canonical === 'OCR.Doc'), true);
  assert.equal(concepts.some((entry) => entry.canonical === 'OCR.DOC'), false);
  assert.equal(concepts.some((entry) => entry.canonical === 'OCR.Admin'), true);
  assert.equal(concepts.some((entry) => entry.canonical === 'OCR.\bAdmin'), false);
});

test('기존 canonical 이 없는 정규화 충돌은 입력 순서와 무관하게 canonical 과 kind 를 결정한다', async () => {
  const firstRoot = await fixtureDataRoot();
  const secondRoot = await fixtureDataRoot();
  const tagCandidates = [
    ['tag-type', '0: OCR.DOC'],
    ['tag-component', '2: OCR.DOC'],
    ['tag-case', 'OCR.Doc'],
  ];
  await writeFile(path.join(firstRoot, 'raw', 'tc-ocr', 'tags.json'), JSON.stringify(Object.fromEntries(tagCandidates)));
  await writeFile(path.join(secondRoot, 'raw', 'tc-ocr', 'tags.json'), JSON.stringify(Object.fromEntries([...tagCandidates].reverse())));

  const first = await seedConcepts({ dataRoot: firstRoot, project: 'tc-ocr', curation: { merges: [], blocks: [] } });
  const second = await seedConcepts({ dataRoot: secondRoot, project: 'tc-ocr', curation: { merges: [], blocks: [] } });
  const firstConcepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(first.outputPath, 'utf8')));
  const secondConcepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(second.outputPath, 'utf8')));
  const firstWinner = firstConcepts.find((entry) => normalizeConceptKey(entry.canonical) === normalizeConceptKey('OCR.DOC'));
  const secondWinner = secondConcepts.find((entry) => normalizeConceptKey(entry.canonical) === normalizeConceptKey('OCR.DOC'));

  assert.deepEqual(firstWinner, secondWinner);
  assert.equal(firstWinner.canonical, 'OCR.DOC');
  assert.equal(firstWinner.kind, 'component');
});

test('removeConflictingAliases 는 판단 alias 를 의도된 canonical 에만 보존한다', () => {
  const entries = removeConflictingAliases(
    [
      { canonical: 'Legacy Gateway', kind: 'component', aliases: ['Gateway'] },
      { canonical: 'OCR API Gateway', kind: 'component', aliases: ['Gateway'] },
    ],
    new Map([[normalizeConceptKey('Gateway'), normalizeConceptKey('OCR API Gateway')]]),
  );
  assert.deepEqual(entries.find((entry) => entry.canonical === 'Legacy Gateway').aliases, []);
  assert.deepEqual(entries.find((entry) => entry.canonical === 'OCR API Gateway').aliases, ['Gateway']);
});

test('fixture 문서 5건을 문서당 1회, 동시 4개 이하로 LLM 추출하고 캐시한다', async () => {
  const dataRoot = await fixtureDataRoot();
  await seedConcepts({ dataRoot, project: 'tc-ocr', curation: { merges: [], blocks: [] } });
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

test('reasoning effort를 LLM mock에 전달하고 effort별 추출 캐시를 분리한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const observedOptions = [];
  const llm = {
    async complete(prompt, options) {
      observedOptions.push(options);
      return { text: JSON.stringify(mockExtraction(sourceDocument(prompt))), elapsedMs: 1 };
    },
  };
  const baseOptions = {
    dataRoot,
    project: 'tc-ocr',
    model: 'effort-model',
    docFilter: ['Task:101'],
    retryDelayMs: 0,
  };

  const low = await extractLlm({ ...baseOptions, effort: 'low', llm });
  assert.equal(low.cacheHits, 0);
  assert.equal(low.calls, 1);
  assert.deepEqual(observedOptions, [{ model: 'effort-model', effort: 'low', timeoutMs: undefined }]);

  const cachedLow = await extractLlm({
    ...baseOptions,
    effort: 'low',
    llm: { complete: async () => { throw new Error('low effort cache miss'); } },
  });
  assert.equal(cachedLow.cacheHits, 1);
  assert.equal(cachedLow.calls, 0);

  const high = await extractLlm({ ...baseOptions, effort: 'high', llm });
  assert.equal(high.cacheHits, 0);
  assert.equal(high.calls, 1);
  assert.deepEqual(observedOptions.at(-1), {
    model: 'effort-model',
    effort: 'high',
    timeoutMs: undefined,
  });

  const lowCache = JSON.parse(await readFile(
    path.join(dataRoot, 'cache', 'effort-model@low', 'Task_3A101.json'),
    'utf8',
  ));
  const highCache = JSON.parse(await readFile(
    path.join(dataRoot, 'cache', 'effort-model@high', 'Task_3A101.json'),
    'utf8',
  ));
  assert.equal(lowCache.model, 'effort-model@low');
  assert.equal(highCache.model, 'effort-model@high');
});

test('LLM Task/Wiki endpoint를 raw id로 교정하고 미해석 관계를 문서별로 드롭한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const postsPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts.json');
  const posts = JSON.parse(await readFile(postsPath, 'utf8'));
  posts.find((post) => post.number === 101).id = '4000000000000000101';
  await writeFile(postsPath, JSON.stringify(posts));
  const wikiPath = path.join(dataRoot, 'raw', 'tc-ocr', 'wiki', '201.json');
  const wiki = JSON.parse(await readFile(wikiPath, 'utf8'));
  wiki.id = '4000000000000000201';
  await writeFile(wikiPath, JSON.stringify(wiki));

  const llm = {
    async complete(prompt) {
      const document = sourceDocument(prompt);
      const extraction = mockExtraction(document);
      if (document.sourceDocId === 'Task:102') {
        extraction.relationships.push(
          {
            type: 'RELATES_TO',
            startKey: 'Task:102',
            endKey: 'Task:4000000000000000101',
            properties: { kind: 'follows-up', sourceDocId: document.sourceDocId },
          },
          {
            type: 'RELATES_TO',
            startKey: 'Task:102',
            endKey: 'Task:4999999999999999999',
            properties: { kind: 'follows-up', sourceDocId: document.sourceDocId },
          },
        );
      }
      if (document.sourceDocId === 'Wiki:201') {
        extraction.relationships.push(
          {
            type: 'DOCUMENTS',
            startKey: 'Wiki:4000000000000000201',
            endKey: 'Concept:Wiki concept 201',
            properties: { sourceDocId: document.sourceDocId },
          },
          {
            type: 'DOCUMENTS',
            startKey: 'Wiki:4999999999999999999',
            endKey: 'Concept:Wiki concept 201',
            properties: { sourceDocId: document.sourceDocId },
          },
        );
      }
      return { text: JSON.stringify(extraction), elapsedMs: 1 };
    },
  };

  const result = await extractLlm({
    dataRoot,
    project: 'tc-ocr',
    model: 'endpoint-model',
    llm,
    retryDelayMs: 0,
  });
  const records = await jsonLines(result.outputPath);
  const relationships = records.filter((record) => 'type' in record);

  assert.equal(result.rewrittenRelationships, 2);
  assert.equal(result.droppedRelationships.count, 2);
  assert.deepEqual(
    result.droppedRelationships.documents.map(({ sourceDocId, count }) => ({ sourceDocId, count })),
    [
      { sourceDocId: 'Task:102', count: 1 },
      { sourceDocId: 'Wiki:201', count: 1 },
    ],
  );
  assert.ok(relationships.some((relationship) => relationship.endKey === 'Task:101'));
  assert.ok(relationships.some((relationship) => relationship.startKey === 'Wiki:201'));
  assert.equal(relationships.some((relationship) => /4999999999999999999/.test(JSON.stringify(relationship))), false);
  assert.deepEqual(
    JSON.parse(await readFile(result.droppedRelationshipsReportPath, 'utf8')),
    { droppedRelationships: result.droppedRelationships },
  );
});

test('기존 inferred.jsonl을 LLM 재호출 없이 같은 endpoint 규칙으로 정제한다', async () => {
  const dataRoot = await fixtureDataRoot();
  const postsPath = path.join(dataRoot, 'raw', 'tc-ocr', 'posts.json');
  const posts = JSON.parse(await readFile(postsPath, 'utf8'));
  posts.find((post) => post.number === 101).id = '4000000000000000101';
  await writeFile(postsPath, JSON.stringify(posts));
  const graphDir = path.join(dataRoot, 'graph', 'tc-ocr');
  await mkdir(graphDir, { recursive: true });
  const llmPath = path.join(graphDir, 'inferred.jsonl');
  await writeFile(llmPath, [
    {
      type: 'RELATES_TO',
      startKey: 'Task:102',
      endKey: 'Task:4000000000000000101',
      properties: { kind: 'follows-up', sourceDocId: 'Task:102' },
    },
    {
      type: 'RELATES_TO',
      startKey: 'Task:102',
      endKey: 'Task:4999999999999999999',
      properties: { kind: 'follows-up', sourceDocId: 'Task:102' },
    },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');

  const result = await sanitizeLlmGraphFile(dataRoot, 'tc-ocr');
  const records = await jsonLines(llmPath);

  assert.equal(result.rewrittenRelationships, 1);
  assert.equal(result.droppedRelationships.count, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].endKey, 'Task:101');
  const repeated = await sanitizeLlmGraphFile(dataRoot, 'tc-ocr');
  assert.equal(repeated.rewrittenRelationships, 0);
  assert.equal(repeated.droppedRelationships.count, 1);
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

test('교정 CLI 실패에도 최초와 교정 호출 수를 모두 보고한다', async () => {
  const dataRoot = await fixtureDataRoot();
  let calls = 0;
  const result = await extractLlm({
    dataRoot,
    project: 'tc-ocr',
    model: 'repair-failure-model',
    llm: {
      async complete(prompt) {
        calls += 1;
        if (prompt.includes('Your previous response was invalid JSON')) throw new Error('rate limited');
        return { text: 'not json', elapsedMs: 1 };
      },
    },
    maxAttempts: 3,
    retryDelayMs: 0,
  });
  assert.equal(calls, 20);
  assert.equal(result.calls, 20);
  assert.equal(result.failed.length, 5);
});

test('교정 응답 파싱 실패에도 최초와 교정 호출 수를 모두 보고한다', async () => {
  const dataRoot = await fixtureDataRoot();
  let calls = 0;
  const result = await extractLlm({
    dataRoot,
    project: 'tc-ocr',
    model: 'repair-invalid-json-model',
    llm: {
      async complete(prompt) {
        calls += 1;
        return { text: prompt.includes('Your previous response was invalid JSON') ? 'still not json' : 'not json', elapsedMs: 1 };
      },
    },
    retryDelayMs: 0,
  });
  assert.equal(calls, 10);
  assert.equal(result.calls, 10);
  assert.equal(result.failed.length, 5);
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
    const codex = LlmResultSchema.parse(await new CodexCliAdapter().complete('codex prompt', { model: 'codex-model', effort: 'low' }));
    assert.equal(codex.text, '{"nodes":[],"relationships":[]}');
    const codexArgs = JSON.parse(await readFile(argsFile, 'utf8'));
    assert.deepEqual(codexArgs.slice(0, 5), ['exec', '--sandbox', 'read-only', '--ephemeral', '--output-last-message']);
    assert.match(codexArgs[5], /devloop-codex-.+\/last-message\.json$/);
    assert.deepEqual(codexArgs.slice(6), [
      '-m', 'codex-model', '-c', 'model_reasoning_effort=low', 'codex prompt',
    ]);

    await new CodexCliAdapter().complete('override prompt', { model: 'codex-model', effort: 'high' });
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')).slice(6), [
      '-m', 'codex-model', '-c', 'model_reasoning_effort=high', 'override prompt',
    ]);

    const claude = LlmResultSchema.parse(await new ClaudeCliAdapter().complete('claude prompt', {
      model: 'claude-model',
      effort: 'high',
    }));
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

test('infer-knowledge 는 LLM_MODEL 이 없으면 LLM 호출 전에 거부한다', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/main.js'), 'infer-knowledge'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NEO4J_URI: 'bolt://localhost:7690',
      LLM_MODEL: '',
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /LLM_MODEL is required for LLM extraction/);
});

test('main dataRoot 는 PIPELINE_DATA_DIR 를 확대 적용하지 않는다', () => {
  const previous = process.env.PIPELINE_DATA_DIR;
  process.env.PIPELINE_DATA_DIR = '/tmp/devloop-should-not-be-main-data-root';
  try {
    assert.equal(resolvePipelineDataRoot(), path.resolve(__dirname, '../data'));
  } finally {
    if (previous === undefined) delete process.env.PIPELINE_DATA_DIR;
    else process.env.PIPELINE_DATA_DIR = previous;
  }
});

test('main 비DB 진입은 NEO4J_URI 없이 설정 검증을 통과한다', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/main.js'), 'unknown-stage'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NEO4J_URI: '' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown pipeline stage: unknown-stage/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /NEO4J_URI/);
});

test('resolve-graph 는 NEO4J_URI 없이 설정 검증을 통과한다', () => {
  const missingDataDir = path.join(os.tmpdir(), `devloop-missing-config-review-${process.pid}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/resolve/cli.js'), '--data-dir', missingDataDir], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NEO4J_URI: '' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /NEO4J_URI/);
});
