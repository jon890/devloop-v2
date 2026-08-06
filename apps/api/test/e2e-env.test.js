const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { assertTestDatabaseUri, DEFAULT_TEST_URI } = require('./helpers/e2e-env');

const apiRoot = path.resolve(__dirname, '..');
const guardPath = path.join(__dirname, 'helpers/e2e-env.js');

test('e2e 가드는 운영 개발 DB 포트를 거부한다', () => {
  for (const uri of ['bolt://localhost:7687', 'bolt://localhost', 'neo4j://graph.internal:7687']) {
    assert.throws(
      () => assertTestDatabaseUri(uri),
      /must never target the production Neo4j port 7687/,
      `${uri} 는 거부되어야 한다`,
    );
  }
  assert.doesNotThrow(() => assertTestDatabaseUri(DEFAULT_TEST_URI));
});

/**
 * 회귀 방지의 핵심.
 * ConfigModule 은 app.module 을 require 하는 시점에 루트 .env 를 읽어 설정을 굳힌다.
 * 가드를 먼저 로드하면 앱이 테스트 DB(7688)를 물어야 하고, 운영 개발 DB(7687)를 물면 안 된다.
 * 별도 프로세스에서 실제로 AppModule 을 띄워 확인한다 — Neo4j 접속은 하지 않는다.
 */
test('가드를 먼저 로드하면 AppModule 이 테스트 DB를 물고 뜬다', () => {
  const resolved = resolveAppConfig({ preload: true });

  assert.equal(resolved.neo4j.uri, DEFAULT_TEST_URI);
  assert.equal(new URL(resolved.neo4j.uri).port, '7688');
  assert.equal(resolved.neo4j.password, 'devloop-test-password');
  assert.equal(resolved.llm.queryModel, 'query-test-model');
});

/**
 * 위 테스트가 무엇을 지키는지 보여 주는 대조군이다.
 * 가드 없이 AppModule 을 로드하면 루트 .env 의 운영 개발 DB(7687)를 문다 — 이것이 고친 회귀다.
 * 루트 .env 가 없는 환경에서는 기동 자체가 실패하므로 그 경우도 통과로 본다.
 */
test('가드 없이 로드하면 테스트 DB가 아닌 곳을 문다', () => {
  let unguardedUri;
  try {
    unguardedUri = resolveAppConfig({ preload: false }).neo4j.uri;
  } catch (error) {
    assert.match(error.message, /API 환경설정 검증 실패/);
    return;
  }
  assert.notEqual(unguardedUri, DEFAULT_TEST_URI);
});

test('e2e 테스트 파일은 app.module 보다 가드를 먼저 require 한다', () => {
  const source = readFileSync(path.join(__dirname, 'api.e2e.test.js'), 'utf8');
  const guardIndex = source.indexOf("require('./helpers/e2e-env')");
  const appModuleIndex = source.indexOf("require('../dist/app.module')");

  assert.notEqual(guardIndex, -1, 'e2e 테스트는 환경 가드를 require 해야 한다');
  assert.notEqual(appModuleIndex, -1);
  assert.ok(guardIndex < appModuleIndex, '환경 가드 require 가 app.module require 보다 앞서야 한다');
});

test('run-e2e 는 --require 로 가드를 선주입한다', () => {
  const source = readFileSync(path.join(__dirname, 'run-e2e.js'), 'utf8');

  assert.match(source, /'--require'/);
  assert.match(source, /envGuardPath/);
});

/** 이 모듈을 require 하면 가드가 이미 환경을 고정한다. 자식에게는 그 흔적을 지우고 넘겨야 검증이 성립한다. */
const CONFIG_ENV_KEYS = [
  'PORT',
  'NEO4J_URI',
  'NEO4J_TEST_URI',
  'NEO4J_AUTH',
  'NEO4J_USER',
  'NEO4J_PASSWORD',
  'NEO4J_DATABASE',
  'LLM_PROVIDER',
  'LLM_TRANSPORT',
  'LLM_MODEL',
  'QUERY_LLM_MODEL',
  'LLM_REASONING_EFFORT',
];

function cleanEnv() {
  const env = { ...process.env };
  for (const key of CONFIG_ENV_KEYS) delete env[key];
  return env;
}

/**
 * 자식 프로세스에서 app.module 을 로드한 뒤 확정된 설정을 돌려받는다.
 *
 * 검증 대상은 **로드 순서**다 — 가드가 app.module 보다 먼저 들어와야 테스트 DB 를 문다.
 * 그래서 app.module 은 require 만 하고 띄우는 것은 ApiConfigModule 이다.
 * AppModule 을 띄우면 LLM_CLI 프로바이더가 상주 `codex app-server` 를 실제로 기동한다 —
 * 설정을 읽는 테스트가 LLM 서버에 매달릴 이유가 없다.
 */
function resolveAppConfig({ preload }) {
  const script = [
    preload ? `require(${JSON.stringify(guardPath)});` : '',
    "require('reflect-metadata');",
    "require('./dist/app.module');",
    "const { NestFactory } = require('@nestjs/core');",
    "const { API_CONFIG, ApiConfigModule } = require('./dist/config');",
    'NestFactory.createApplicationContext(ApiConfigModule, { logger: false })',
    '  .then(async (app) => {',
    '    process.stdout.write(JSON.stringify(app.get(API_CONFIG)));',
    '    await app.close();',
    '  })',
    '  .catch((error) => { process.stderr.write(error.message); process.exit(1); });',
  ].join('\n');

  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      cwd: apiRoot,
      env: cleanEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}
