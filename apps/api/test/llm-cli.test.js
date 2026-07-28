const assert = require('node:assert/strict');
const { chmod, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClaudeCliAdapter, CodexCliAdapter, createLlmCli } = require('../dist/llm-cli');
const { QueryService } = require('../dist/query/query.service');
const { testApiConfig } = require('./helpers/test-config');

test('API CLI 어댑터가 Codex effort를 전달하고 Claude에서는 무시한다', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'devloop-api-cli-test-'));
  const argsFile = path.join(temporary, 'args.json');
  const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.DEVLOOP_API_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('mock response'));
`;
  const codexPath = path.join(temporary, 'codex');
  const claudePath = path.join(temporary, 'claude');
  await Promise.all([
    writeFile(codexPath, fakeCli, 'utf8'),
    writeFile(claudePath, fakeCli, 'utf8'),
  ]);
  await Promise.all([chmod(codexPath, 0o755), chmod(claudePath, 0o755)]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${temporary}:${previousPath}`;
  process.env.DEVLOOP_API_ARGS_FILE = argsFile;
  const lowEffortConfig = testApiConfig({
    llm: { provider: 'codex', queryModel: 'query-model', reasoningEffort: 'low' },
  });
  try {
    const codex = await new CodexCliAdapter(lowEffortConfig).complete('prompt', { model: 'codex-model' });
    assert.equal(codex.text, 'mock response');
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      'exec', '-m', 'codex-model', '-c', 'model_reasoning_effort=low',
    ]);

    await new CodexCliAdapter(lowEffortConfig).complete('prompt', { model: 'codex-model', effort: 'high' });
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      'exec', '-m', 'codex-model', '-c', 'model_reasoning_effort=high',
    ]);

    const claude = await new ClaudeCliAdapter(lowEffortConfig).complete('prompt', {
      model: 'claude-model',
      effort: 'medium',
    });
    assert.equal(claude.text, 'mock response');
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      '-p', '--model', 'claude-model',
    ]);

    // opts.model이 없으면 환경설정의 QUERY_LLM_MODEL이 그대로 쓰인다.
    await new CodexCliAdapter(lowEffortConfig).complete('prompt');
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      'exec', '-m', 'query-model', '-c', 'model_reasoning_effort=low',
    ]);

    const noEffortConfig = testApiConfig({ llm: { provider: 'claude', queryModel: 'query-model' } });
    await new ClaudeCliAdapter(noEffortConfig).complete('prompt');
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      '-p', '--model', 'query-model',
    ]);

    await new CodexCliAdapter(noEffortConfig).complete('prompt');
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), ['exec', '-m', 'query-model']);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.DEVLOOP_API_ARGS_FILE;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('createLlmCli가 환경설정의 LLM_PROVIDER로 어댑터를 고른다', () => {
  assert.ok(createLlmCli(testApiConfig({ llm: { provider: 'codex', queryModel: 'm' } })) instanceof CodexCliAdapter);
  assert.ok(createLlmCli(testApiConfig({ llm: { provider: 'claude', queryModel: 'm' } })) instanceof ClaudeCliAdapter);
});

test('QueryService가 환경설정의 질의 모델을 LLM 호출에 전달한다', async () => {
  const options = [];
  const llmCli = {
    async complete(prompt, opts) {
      options.push(opts);
      return { text: JSON.stringify({ cypher: 'MATCH (n) RETURN n LIMIT 1' }) };
    },
  };
  const service = new QueryService({}, llmCli, testApiConfig({ llm: { provider: 'codex', queryModel: 'terra-model' } }));

  await service.generateCypher('질문', []);

  assert.deepEqual(options.map((option) => option.model), ['terra-model']);
});

test('Cypher 생성 프롬프트가 TAGGED 차원과 차원 조합 집계 패턴을 설명한다', async () => {
  let generationPrompt;
  const llmCli = {
    async complete(prompt) {
      generationPrompt = prompt;
      return { text: JSON.stringify({ cypher: 'MATCH (n) RETURN n LIMIT 1' }) };
    },
  };
  const service = new QueryService({}, llmCli, testApiConfig());

  await service.generateCypher('한 태그 차원으로 Task를 고르고 다른 태그 차원별로 집계', []);

  assert.match(generationPrompt, /TAGGED\.dimension은 문자열/);
  assert.match(generationPrompt, /"0"은 유형, "1"은 제품, "2"는 컴포넌트/);
  assert.match(generationPrompt, /한 Task는 서로 다른 차원의 여러 Concept에 TAGGED될 수 있다/);
  assert.match(
    generationPrompt,
    /MATCH \(t:Task\)-\[typeTag:TAGGED\]->\(:Concept \{name:"개선"\}\).*MATCH \(t\)-\[groupTag:TAGGED\]->\(c:Concept\)/,
  );
  assert.match(generationPrompt, /typeTag\.dimension = "0"/);
  assert.match(generationPrompt, /groupTag\.dimension = "2"/);
  assert.match(generationPrompt, /RETURN c\.name, count\(t\)/);
});

test('Cypher 생성 프롬프트가 개념을 다루는 문서에 MENTIONS와 DOCUMENTS를 함께 매치하도록 지시한다', async () => {
  let generationPrompt;
  const llmCli = {
    async complete(prompt) {
      generationPrompt = prompt;
      return { text: JSON.stringify({ cypher: 'MATCH (n) RETURN n LIMIT 1' }) };
    },
  };
  const service = new QueryService({}, llmCli, testApiConfig());

  await service.generateCypher('ingress-nginx를 다루는 문서를 찾아줘', []);

  const relationHint = generationPrompt
    .split('\n')
    .find((line) => line.includes('DOCUMENTS') && line.includes('MENTIONS'));

  assert.ok(relationHint, '두 관계를 함께 설명하는 줄이 생성 프롬프트에 있어야 한다');
  assert.match(relationHint, /DOCUMENTS는 MENTIONS의 강한 형태/);
  assert.match(relationHint, /\[:MENTIONS\|DOCUMENTS\]/);
  assert.match(relationHint, /함께 MATCH/);

  assert.match(generationPrompt, /^MENTIONS: Task\|Wiki -> Concept$/m);
  assert.match(generationPrompt, /^DOCUMENTS: Wiki -> Concept$/m);
});

test('anchor 용어 추출 프롬프트가 기술 용어의 한영 표기 변형을 양방향으로 요구한다', async () => {
  const anchorPrompts = [];
  const llmCli = {
    async complete(prompt) {
      anchorPrompts.push(prompt);
      const terms = prompt.includes('게이트웨이 뺀 거')
        ? ['게이트웨이', 'gateway', 'API Gateway', '제거']
        : ['ingress', '잉그레스', '제거'];
      return { text: JSON.stringify({ terms }) };
    },
  };
  const service = new QueryService({}, llmCli, testApiConfig());

  const koreanTerms = await service.extractAnchorTerms('게이트웨이 뺀 거 왜 그랬지?');
  const englishTerms = await service.extractAnchorTerms('ingress 제거 배경은?');

  assert.deepEqual(koreanTerms, ['게이트웨이', 'gateway', 'API Gateway', '제거']);
  assert.deepEqual(englishTerms, ['ingress', '잉그레스', '제거']);
  const anchorPrompt = anchorPrompts[0];
  assert.match(anchorPrompt, /기술 외래어 또는 제품명/);
  assert.match(anchorPrompt, /한국어·영어 표기 변형을 양방향으로 생성/);
  assert.match(anchorPrompt, /한국어로 적힌 기술 용어에는 원어 영어 표기/);
  assert.match(anchorPrompt, /영어 용어에는 통용되는 한국어 음역 표기/);
  assert.match(anchorPrompt, /게이트웨이 → gateway, API Gateway/);
  assert.match(anchorPrompt, /원문 핵심 용어와 생성한 모든 표기 변형을 각각 독립된 검색어/);
});

test('이유·결정 질문의 Cypher 생성 프롬프트가 다중 Task 후보의 Decision과 근거 Comment를 요구한다', async () => {
  let generationPrompt;
  const llmCli = {
    async complete(prompt) {
      generationPrompt = prompt;
      return { text: JSON.stringify({ cypher: 'MATCH (n) RETURN n LIMIT 1' }) };
    },
  };
  const service = new QueryService({}, llmCli, testApiConfig());

  await service.generateCypher('그 구성 요소를 뺀 배경은?', [
    {
      node: {
        id: 'task-489',
        label: 'Task',
        key: '489',
        display: '구성 요소 장애 대응',
        properties: {},
      },
      decisionCount: 0,
    },
    {
      node: {
        id: 'task-483',
        label: 'Task',
        key: '483',
        display: '구성 요소 제거',
        properties: {},
      },
      decisionCount: 8,
    },
    {
      node: {
        id: 'wiki-1',
        label: 'Wiki',
        key: '1',
        display: '구성 요소 운영',
        properties: {},
      },
    },
  ]);

  assert.match(generationPrompt, /왜, 이유, 사유, 배경, 어떻게 결정, why/);
  assert.match(generationPrompt, /fulltext 1위 후보 하나만 정답으로 확정하지 마라/);
  assert.match(
    generationPrompt,
    /MATCH \(d:Decision\)-\[:DECIDED_IN\]->\(t:Task\) WHERE t\.number IN \[\.\.\.\]/,
  );
  assert.match(generationPrompt, /특정 Task 한 건의 \{number: \.\.\.\} 패턴으로 먼저 좁히지 마라/);
  assert.match(generationPrompt, /d\.summary와 EVIDENCED_BY Comment를 질문과 비교/);
  assert.match(generationPrompt, /\[evidenced:EVIDENCED_BY\]->\(comment:Comment\)/);
  assert.match(generationPrompt, /WHERE t\.number IN \[123, 117, 109\]/);
  assert.match(
    generationPrompt,
    /"label":"Task","key":"489","display":"구성 요소 장애 대응","decisionCount":0/,
  );
  assert.match(
    generationPrompt,
    /"label":"Task","key":"483","display":"구성 요소 제거","decisionCount":8/,
  );
  assert.doesNotMatch(
    generationPrompt,
    /"label":"Wiki","key":"1","display":"구성 요소 운영","decisionCount"/,
  );
  assert.match(generationPrompt, /Task: number\(int\), subject, workflowClass, createdAt, bodyExcerpt/);
});

test('답변 합성 프롬프트가 다중 후보 중 질문과 관련성 높은 Decision 근거를 선택한다', async () => {
  let synthesisPrompt;
  const llmCli = {
    async complete(prompt) {
      synthesisPrompt = prompt;
      return { text: JSON.stringify({ answer: '관련 근거' }) };
    },
  };
  const service = new QueryService({}, llmCli, testApiConfig());

  await service.synthesizeAnswer(
    '그 구성 요소를 뺀 배경은?',
    [{ taskNumber: 489 }, { taskNumber: 483 }],
    { nodes: [], relationships: [] },
  );

  assert.match(synthesisPrompt, /여러 Task 후보의 Decision이 함께 조회/);
  assert.match(synthesisPrompt, /행 순서나 fulltext 1위만으로 단정하지 말고/);
  assert.match(synthesisPrompt, /Task subject·Decision summary·Comment excerpt를 질문과 비교/);
});
