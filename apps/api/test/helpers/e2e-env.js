/**
 * e2e 환경변수 고정 모듈.
 *
 * `dist/app.module` 을 require 하는 순간 ConfigModule 이 저장소 루트 `.env` 를 읽어
 * 설정을 굳힌다. 루트 `.env` 의 NEO4J_URI 는 운영 개발 DB(7687)다.
 * 그래서 테스트 DB 지정은 반드시 app.module 이 로드되기 **전에** 끝나야 한다.
 *
 * 이 모듈은 require 되는 즉시 환경을 고정한다. 두 경로로 진입한다.
 * - `run-e2e.js` 가 node `--require` 로 선주입 (실행 순서를 node 가 보장한다)
 * - `api.e2e.test.js` 첫 줄에서 직접 require (테스트 파일을 단독 실행할 때)
 *
 * 두 번 실행돼도 결과가 같다.
 */
const assert = require('node:assert/strict');

const PRODUCTION_BOLT_PORT = '7687';
const DEFAULT_TEST_URI = 'bolt://localhost:7688';

const E2E_ENV = {
  NEO4J_USER: 'neo4j',
  NEO4J_PASSWORD: 'devloop-test-password',
  LLM_MODEL: 'extraction-test-model',
  QUERY_LLM_MODEL: 'query-test-model',
  LLM_PROVIDER: 'codex',
  LLM_TRANSPORT: 'responses',
};

/** 운영 개발 DB 포트를 가리키는 URI 를 거부한다. 포트가 없으면 bolt 기본값 7687 로 본다. */
function assertTestDatabaseUri(uri) {
  const parsed = new URL(uri);
  assert.notEqual(
    parsed.port || PRODUCTION_BOLT_PORT,
    PRODUCTION_BOLT_PORT,
    'NEO4J_TEST_URI must never target the production Neo4j port 7687.',
  );
}

/**
 * 테스트 DB URI 와 자격증명을 process.env 에 고정한다.
 * NEO4J_AUTH 는 지운다 — 루트 `.env` 에서 흘러 들어오면 운영 비밀번호가 섞인다.
 */
function applyE2eEnv() {
  const testUri = process.env.NEO4J_TEST_URI ?? DEFAULT_TEST_URI;
  assertTestDatabaseUri(testUri);

  process.env.NEO4J_TEST_URI = testUri;
  process.env.NEO4J_URI = testUri;
  delete process.env.NEO4J_AUTH;
  for (const [key, value] of Object.entries(E2E_ENV)) {
    process.env[key] = value;
  }
  return testUri;
}

module.exports = { applyE2eEnv, assertTestDatabaseUri, DEFAULT_TEST_URI, PRODUCTION_BOLT_PORT };

// require 시점 부수효과. app.module 보다 먼저 로드되는 것이 이 모듈의 존재 이유다.
applyE2eEnv();
