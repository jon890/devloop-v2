const assert = require('node:assert/strict');
const { test } = require('node:test');
const { QueryService } = require('../dist/query/query.service');
const { testApiConfig } = require('./helpers/test-config');

function serviceCapturingPrompt(prompts) {
  const llmCli = {
    async complete(prompt) {
      prompts.push(prompt);
      return { text: JSON.stringify({ cypher: 'MATCH (t:Task) RETURN t LIMIT 50' }) };
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

test('Cypher 프롬프트가 근거 그래프를 RETURN 하라는 지시를 유지한다', async () => {
  const prompts = [];
  const service = serviceCapturingPrompt(prompts);

  await service.generateCypher('아무 질문', []);

  assert.match(prompts[0], /비집계 질의는 가능하면 node, relationship, path를 RETURN/);
});
