const assert = require('node:assert/strict');
const test = require('node:test');

const { validateApiConfig } = require('../dist/config');

/** 모든 필수 값이 채워진 최소 환경. 각 테스트가 여기서 하나씩 빼거나 바꾼다. */
function validEnv(overrides = {}) {
  const env = {
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_AUTH: 'neo4j/devloop-password',
    QUERY_LLM_MODEL: 'gpt-5.6-terra',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

test('필수 값이 모두 있으면 설정으로 파싱된다', () => {
  const config = validateApiConfig(validEnv());

  assert.deepEqual(config, {
    port: 3000,
    neo4j: {
      uri: 'bolt://localhost:7687',
      database: 'neo4j',
      user: 'neo4j',
      password: 'devloop-password',
    },
    llm: {
      provider: 'codex',
      transport: 'responses',
      queryModel: 'gpt-5.6-terra',
      reasoningEffort: 'high',
    },
  });
});

test('선택 값은 지정하면 반영되고 생략하면 기본값을 쓴다', () => {
  const config = validateApiConfig(
    validEnv({ PORT: '4000', NEO4J_DATABASE: 'graph', LLM_REASONING_EFFORT: 'high' }),
  );

  assert.equal(config.port, 4000);
  assert.equal(config.neo4j.database, 'graph');
  assert.equal(config.llm.reasoningEffort, 'high');

  const defaults = validateApiConfig(validEnv());
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.neo4j.database, 'neo4j');
  assert.equal(defaults.llm.reasoningEffort, 'high');
});

test('필수 값이 없으면 기동을 막는 예외가 난다', () => {
  for (const key of ['NEO4J_URI', 'QUERY_LLM_MODEL']) {
    assert.throws(
      () => validateApiConfig(validEnv({ [key]: undefined })),
      (error) => error.message.includes('API 환경설정 검증 실패') && error.message.includes(key),
      `${key} 누락은 검증 실패여야 한다`,
    );
  }
});

test('필수 값이 빈 문자열이면 값 없음으로 보고 실패한다', () => {
  assert.throws(() => validateApiConfig(validEnv({ QUERY_LLM_MODEL: '   ' })), /QUERY_LLM_MODEL/);
  assert.throws(() => validateApiConfig(validEnv({ NEO4J_URI: '' })), /NEO4J_URI/);
});

test('선택 값이 빈 문자열이면 기본값으로 되돌아간다', () => {
  const config = validateApiConfig(validEnv({ PORT: '', NEO4J_DATABASE: '', LLM_REASONING_EFFORT: '' }));

  assert.equal(config.port, 3000);
  assert.equal(config.neo4j.database, 'neo4j');
  assert.equal(config.llm.reasoningEffort, 'high');
});

test('NEO4J_AUTH를 user와 password로 분해한다', () => {
  const config = validateApiConfig(validEnv({ NEO4J_AUTH: 'graph-reader/p@ss/word' }));

  assert.equal(config.neo4j.user, 'graph-reader');
  // 첫 "/"만 구분자다. 비밀번호에 "/"가 들어가도 잘리지 않아야 한다.
  assert.equal(config.neo4j.password, 'p@ss/word');
});

test('형식이 어긋난 NEO4J_AUTH는 실패한다', () => {
  for (const value of ['neo4j', '/password', 'neo4j/']) {
    assert.throws(
      () => validateApiConfig(validEnv({ NEO4J_AUTH: value })),
      /NEO4J_AUTH 는 user\/password 형식이어야 한다/,
      `${value} 는 거부되어야 한다`,
    );
  }
});

test('NEO4J_USER와 NEO4J_PASSWORD 쌍도 자격증명 경로로 받는다', () => {
  const config = validateApiConfig(
    validEnv({ NEO4J_AUTH: undefined, NEO4J_USER: 'reader', NEO4J_PASSWORD: 'secret' }),
  );

  assert.equal(config.neo4j.user, 'reader');
  assert.equal(config.neo4j.password, 'secret');
});

test('자격증명이 아예 없으면 실패한다 — 하드코딩 기본 비밀번호로 뜨지 않는다', () => {
  assert.throws(
    () => validateApiConfig(validEnv({ NEO4J_AUTH: undefined })),
    /Neo4j 자격증명이 없다/,
  );
});

test('NEO4J_USER와 NEO4J_PASSWORD 중 하나만 있으면 실패한다', () => {
  assert.throws(
    () => validateApiConfig(validEnv({ NEO4J_AUTH: undefined, NEO4J_USER: 'reader' })),
    /함께 지정해야 한다/,
  );
  assert.throws(
    () => validateApiConfig(validEnv({ NEO4J_AUTH: undefined, NEO4J_PASSWORD: 'secret' })),
    /함께 지정해야 한다/,
  );
});

test('두 자격증명 경로가 함께 있으면 NEO4J_USER/NEO4J_PASSWORD 쌍이 이긴다', () => {
  const config = validateApiConfig(validEnv({ NEO4J_USER: 'reader', NEO4J_PASSWORD: 'override' }));

  assert.equal(config.neo4j.user, 'reader');
  assert.equal(config.neo4j.password, 'override');
});

test('열거형에 없는 값은 실패한다', () => {
  assert.throws(
    () => validateApiConfig(validEnv({ LLM_REASONING_EFFORT: 'unsupported' })),
    /LLM_REASONING_EFFORT/,
  );
});

test('LLM_PROVIDER 는 생략하면 codex 이고, codex 와 claude 만 받는다', () => {
  assert.equal(validateApiConfig(validEnv({ LLM_PROVIDER: undefined })).llm.provider, 'codex');
  assert.equal(validateApiConfig(validEnv({ LLM_PROVIDER: '' })).llm.provider, 'codex');
  const claude = validateApiConfig(validEnv({ LLM_PROVIDER: 'claude' })).llm;
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.transport, 'claude');

  // 예전에는 `!== "claude"` 분기라 오타가 조용히 codex 로 갔다. 이제는 기동이 멈춘다.
  for (const value of ['codexx', 'Codex', 'gpt', 'claude-code']) {
    assert.throws(
      () => validateApiConfig(validEnv({ LLM_PROVIDER: value })),
      /LLM_PROVIDER/,
      `${value} 는 거부되어야 한다`,
    );
  }
});

test('LLM_TRANSPORT 기본값과 허용 목록을 검증한다', () => {
  assert.equal(validateApiConfig(validEnv()).llm.transport, 'responses');
  assert.equal(validateApiConfig(validEnv({ LLM_TRANSPORT: 'app-server' })).llm.transport, 'app-server');
  assert.throws(() => validateApiConfig(validEnv({ LLM_TRANSPORT: 'agent' })), /LLM_TRANSPORT/);
});

test('LLM_PROVIDER와 LLM_TRANSPORT가 모순되면 기동을 막는다', () => {
  assert.throws(
    () => validateApiConfig(validEnv({ LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'app-server' })),
    /LLM_PROVIDER=claude.*LLM_TRANSPORT=claude/,
  );
  assert.throws(
    () => validateApiConfig(validEnv({ LLM_PROVIDER: 'codex', LLM_TRANSPORT: 'claude' })),
    /LLM_TRANSPORT=claude.*LLM_PROVIDER=claude/,
  );
});

test('PORT가 숫자가 아니거나 0 이하이면 실패한다', () => {
  for (const value of ['not-a-number', '0', '-1', '1.5']) {
    assert.throws(() => validateApiConfig(validEnv({ PORT: value })), /PORT/, `${value} 는 거부되어야 한다`);
  }
});

test('알 수 없는 환경변수는 설정에 새어 들어오지 않는다', () => {
  const config = validateApiConfig(validEnv({ NEO4J_TEST_URI: 'bolt://localhost:7688', LLM_MODEL: 'gpt-5.5' }));

  assert.deepEqual(Object.keys(config).sort(), ['llm', 'neo4j', 'port']);
  // 추출용 LLM_MODEL은 파이프라인 소유다. API 질의 모델로 새어 들어오면 안 된다.
  assert.equal(config.llm.queryModel, 'gpt-5.6-terra');
});
