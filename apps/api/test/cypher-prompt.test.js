const assert = require('node:assert/strict');
const { test } = require('node:test');
const { QueryService } = require('../dist/query/query.service');
const { testApiConfig } = require('./helpers/test-config');

function serviceCapturingPrompt(prompts, calls = []) {
  const llmCli = {
    async complete(prompt, opts) {
      prompts.push(prompt);
      calls.push({ prompt, opts });
      // 세 계약을 한 응답으로 만족시킨다. z.object 는 모르는 키를 버리므로 어느 계약으로도 통과한다.
      return {
        text: JSON.stringify({ cypher: 'MATCH (t:Task) RETURN t LIMIT 50', terms: ['용어'], answer: '답변' }),
      };
    },
  };
  return new QueryService({}, llmCli, testApiConfig());
}

// 실측 회귀다. 497 의 변경이 499 에서 어떻게 검증됐는지 묻는 질문에 생성된 Cypher 가 499 의 댓글만
// 확장해 497 의 근거 댓글 2건을 놓쳤다. 회수 실패 8회 중 5회가 "한 업무만 댓글 확장" 이었고
// 3회는 HAS_COMMENT 를 아예 쓰지 않았다.
test('Cypher 프롬프트가 지목된 모든 Task 의 댓글을 확장하라고 지시한다', async () => {
  const prompts = [];
  const service = serviceCapturingPrompt(prompts);

  await service.generateCypher('Task 497 의 변경이 Task 499 에서 어떻게 검증됐는지 설명하라', []);

  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  assert.match(prompt, /지목된 모든 Task 의 댓글을 함께/, '모든 업무의 댓글을 확장하라는 지시가 있다');
  assert.match(prompt, /HAS_COMMENT/, 'HAS_COMMENT 확장 형태를 보여 준다');
  assert.match(prompt, /t\.number IN \[/, 'number 목록 패턴을 보여 준다');
});

// 실측 회귀다. 7개 업무를 지목한 Cypher 가 6개 OPTIONAL MATCH 를 이어 붙여 행이 곱으로 퍼졌고,
// 전역 LIMIT 50 이 그것을 잘라 업무 노드를 통째로 잃었다. task-494 를 6회 전부 놓쳤다.
test('Cypher 프롬프트가 다수 Task 확장을 collect 로 접으라고 지시한다', async () => {
  const prompts = [];
  const service = serviceCapturingPrompt(prompts);

  await service.generateCypher('Task 483 부터 506 까지 전체 흐름을 재구성하라', []);

  const prompt = prompts[0];
  assert.match(prompt, /Task 를 셋 이상 지목하면 OPTIONAL MATCH 를 여러 개 이어 붙이지 마라/);
  assert.match(prompt, /collect\(DISTINCT/, 'collect 로 접는 형태를 보여 준다');
  assert.match(prompt, /Task 하나당 한 행/, '업무당 한 행이라는 목표를 밝힌다');
});

test('Cypher 프롬프트가 근거 그래프를 RETURN 하라는 지시를 유지한다', async () => {
  const prompts = [];
  const service = serviceCapturingPrompt(prompts);

  await service.generateCypher('아무 질문', []);

  assert.match(prompts[0], /비집계 질의는 가능하면 node, relationship, path를 RETURN/);
});

// 형식 계약은 outputSchema 로 서버가 보장하므로 프롬프트에서 뺐다. 되돌아오면 호출이 두 배가 되고
// 스키마와 프롬프트가 서로 다른 형식을 요구할 수 있으므로 문구가 다시 들어오는 것을 막는다.
test('네 프롬프트 모두 JSON 형식 지시를 담지 않는다', async () => {
  const prompts = [];
  const service = serviceCapturingPrompt(prompts);

  await service.extractAnchorTerms('아무 질문');
  await service.generateCypher('아무 질문', []);
  await service.generateEvidenceCypher('아무 질문', 'MATCH (t:Task) RETURN count(t)', [], []);
  await service.synthesizeAnswer('아무 질문', [], { nodes: [], relationships: [] });

  assert.equal(prompts.length, 4);
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /JSON 하나만/, '형식 지시는 프롬프트가 아니라 outputSchema 가 담는다');
  }
});

// 행 상한 지시는 형식 문구와 같은 줄에 섞여 있었다. 그 줄을 지우면서 함께 사라지기 쉬우므로
// 두 Cypher 프롬프트 양쪽에서 단정한다. few-shot 예시의 LIMIT 50 은 명시 지시가 아니다.
test('두 Cypher 프롬프트가 행 상한을 지시한다', async () => {
  const prompts = [];
  const service = serviceCapturingPrompt(prompts);

  await service.generateCypher('아무 질문', []);
  await service.generateEvidenceCypher('아무 질문', 'MATCH (t:Task) RETURN count(t)', [], []);

  assert.match(prompts[0], /반환 행은 50개를 넘기지 마라/, 'Cypher 생성 프롬프트가 행 상한을 지시한다');
  assert.match(prompts[1], /반환 행은 50개를 넘기지 마라/, '근거 Cypher 프롬프트가 행 상한을 지시한다');
});

// 스키마는 모양만 보장하고 내용은 보지 않는다. 형식 줄을 뺄 때 표기 변형·조사 제외 같은
// 내용 지시를 함께 지우면 앵커 품질이 떨어진다.
test('앵커 프롬프트가 표기 변형과 조사 제외 지시를 유지한다', async () => {
  const prompts = [];
  const service = serviceCapturingPrompt(prompts);

  await service.extractAnchorTerms('쿠버네티스 게이트웨이 왜 바꿨어');

  assert.match(prompts[0], /한국어·영어 표기 변형을 양방향으로 생성하라/);
  assert.match(prompts[0], /일반적인 조사·서술어·의문 표현은 제외하라/);
});

test('네 호출 모두 응답 계약을 outputSchema 로 넘긴다', async () => {
  const calls = [];
  const service = serviceCapturingPrompt([], calls);

  await service.extractAnchorTerms('아무 질문');
  await service.generateCypher('아무 질문', []);
  await service.generateEvidenceCypher('아무 질문', 'MATCH (t:Task) RETURN count(t)', [], []);
  await service.synthesizeAnswer('아무 질문', [], { nodes: [], relationships: [] });

  assert.equal(calls.length, 4);
  const properties = calls.map(({ opts }) => Object.keys(opts.outputSchema.properties));
  assert.deepEqual(properties, [['terms'], ['cypher'], ['cypher'], ['answer']]);
  for (const { opts } of calls) {
    assert.equal(opts.outputSchema.type, 'object');
  }
});
