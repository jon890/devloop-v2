const assert = require('node:assert/strict');
const { test } = require('node:test');
const { QueryService } = require('../dist/query/query.service');
const {
  AnchorResponseContract,
  AnswerResponseContract,
  CypherResponseContract,
} = require('../dist/query/query.schema');
const { testApiConfig } = require('./helpers/test-config');

test('세 응답 계약이 required 와 길이 제약을 담은 JSON Schema 로 변환된다', () => {
  assert.deepEqual(AnchorResponseContract.outputSchema.required, ['terms']);
  assert.equal(AnchorResponseContract.outputSchema.type, 'object');
  assert.equal(AnchorResponseContract.outputSchema.properties.terms.type, 'array');
  assert.equal(AnchorResponseContract.outputSchema.properties.terms.minItems, 1);
  assert.equal(AnchorResponseContract.outputSchema.properties.terms.items.minLength, 1);

  assert.deepEqual(CypherResponseContract.outputSchema.required, ['cypher']);
  assert.equal(CypherResponseContract.outputSchema.properties.cypher.type, 'string');
  assert.equal(CypherResponseContract.outputSchema.properties.cypher.minLength, 1);

  assert.deepEqual(AnswerResponseContract.outputSchema.required, ['answer']);
  assert.equal(AnswerResponseContract.outputSchema.properties.answer.type, 'string');
  assert.equal(AnswerResponseContract.outputSchema.properties.answer.minLength, 1);
});

function serviceReturning(text, calls) {
  const llmCli = {
    async complete(prompt, opts) {
      calls.push({ prompt, opts });
      return { text };
    },
  };
  return new QueryService({}, llmCli, testApiConfig());
}

// 형식 위반은 outputSchema 로 원리적으로 안 생기므로, 검증 실패는 계약이 깨진 것이다.
// 재시도로 덮으면 결함이 드러나지 않은 채 호출만 두 배가 된다.
test('검증 실패는 재시도하지 않고 즉시 오류로 올린다', async () => {
  const calls = [];
  const service = serviceReturning('여기 키워드를 알려 드립니다', calls);

  await assert.rejects(() => service.extractAnchorTerms('아무 질문'));
  assert.equal(calls.length, 1, '같은 요청을 두 번 보내지 않는다');
});

test('계약을 어긴 JSON 도 재시도 없이 오류로 올린다', async () => {
  const calls = [];
  const service = serviceReturning(JSON.stringify({ terms: [] }), calls);

  await assert.rejects(() => service.extractAnchorTerms('아무 질문'));
  assert.equal(calls.length, 1);
});

// 스키마는 상수라 변환은 모듈 로드 때 한 번만 한다. 호출마다 다시 만들면 같은 값을 매번 계산한다.
test('호출마다 JSON Schema 를 다시 만들지 않고 상수를 그대로 넘긴다', async () => {
  const calls = [];
  const service = serviceReturning(JSON.stringify({ cypher: 'MATCH (t:Task) RETURN t LIMIT 50' }), calls);

  await service.generateCypher('아무 질문', []);
  await service.generateCypher('다른 질문', []);

  assert.equal(calls[0].opts.outputSchema, CypherResponseContract.outputSchema);
  assert.equal(calls[1].opts.outputSchema, CypherResponseContract.outputSchema);
});
