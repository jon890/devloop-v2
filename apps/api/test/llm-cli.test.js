const assert = require('node:assert/strict');
const { chmod, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClaudeCliAdapter, CodexCliAdapter } = require('../dist/llm-cli');

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
  const previousEffort = process.env.LLM_REASONING_EFFORT;
  process.env.PATH = `${temporary}:${previousPath}`;
  process.env.DEVLOOP_API_ARGS_FILE = argsFile;
  process.env.LLM_REASONING_EFFORT = 'low';
  try {
    const codex = await new CodexCliAdapter().complete('prompt', { model: 'codex-model' });
    assert.equal(codex.text, 'mock response');
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      'exec', '-m', 'codex-model', '-c', 'model_reasoning_effort=low',
    ]);

    await new CodexCliAdapter().complete('prompt', { model: 'codex-model', effort: 'high' });
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      'exec', '-m', 'codex-model', '-c', 'model_reasoning_effort=high',
    ]);

    process.env.LLM_REASONING_EFFORT = 'unsupported';
    assert.throws(
      () => new CodexCliAdapter().complete('prompt', { model: 'codex-model' }),
      /Unsupported LLM reasoning effort: unsupported/,
    );

    const claude = await new ClaudeCliAdapter().complete('prompt', {
      model: 'claude-model',
      effort: 'medium',
    });
    assert.equal(claude.text, 'mock response');
    assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), [
      '-p', '--model', 'claude-model',
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousEffort === undefined) delete process.env.LLM_REASONING_EFFORT;
    else process.env.LLM_REASONING_EFFORT = previousEffort;
    delete process.env.DEVLOOP_API_ARGS_FILE;
    await rm(temporary, { recursive: true, force: true });
  }
});
