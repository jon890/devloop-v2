const assert = require('node:assert/strict');
const { chmod, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClaudeCliAdapter, CodexCliAdapter } = require('../dist/llm-cli');
const { GraphQueryService } = require('../dist/graph-query.service');

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

test('Cypher 생성 프롬프트가 TAGGED 차원과 차원 조합 집계 패턴을 설명한다', async () => {
  let generationPrompt;
  const llmCli = {
    async complete(prompt) {
      generationPrompt = prompt;
      return { text: JSON.stringify({ cypher: 'MATCH (n) RETURN n LIMIT 1' }) };
    },
  };
  const service = new GraphQueryService({}, llmCli);

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
