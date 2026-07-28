const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
// require 즉시 테스트 DB 로 환경을 고정한다. 아래 spawn 이 그 환경을 그대로 물려준다.
const { applyE2eEnv } = require('./helpers/e2e-env');

const repoRoot = resolve(__dirname, '../../..');
const envGuardPath = resolve(__dirname, 'helpers/e2e-env.js');
const testUri = applyE2eEnv();

const environment = {
  ...process.env,
  NEO4J_TEST_URI: testUri,
};

try {
  run('docker', ['compose', '--profile', 'test', 'up', '-d', '--wait', 'neo4j-test']);
  // --require 로 선주입한다. 테스트 파일이 dist/app.module 을 언제 require 하든
  // 환경 고정이 먼저 끝나는 것을 node 가 보장한다.
  run(process.execPath, [
    '--test',
    '--test-concurrency=1',
    '--require',
    envGuardPath,
    'apps/api/test/api.e2e.test.js',
  ]);
} finally {
  spawnSync(
    'docker',
    ['compose', '--profile', 'test', 'rm', '--stop', '--force', 'neo4j-test'],
    { cwd: repoRoot, env: environment, stdio: 'inherit' },
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
}
