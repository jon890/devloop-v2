const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const repoRoot = resolve(__dirname, '../../..');
const testUri = process.env.NEO4J_TEST_URI ?? 'bolt://localhost:7688';
const parsedTestUri = new URL(testUri);

if ((parsedTestUri.port || '7687') === '7687') {
  throw new Error('NEO4J_TEST_URI must never target the production Neo4j port 7687.');
}

const environment = {
  ...process.env,
  NEO4J_TEST_URI: testUri,
};

try {
  run('docker', ['compose', '--profile', 'test', 'up', '-d', '--wait', 'neo4j-test']);
  run(process.execPath, ['--test', '--test-concurrency=1', 'apps/api/test/api.e2e.test.js']);
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
