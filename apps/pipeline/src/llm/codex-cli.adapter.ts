import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LlmCli, LlmOptions, LlmResult } from './llm-cli';
import { runCliProcess } from './cli-process';

export class CodexCliAdapter implements LlmCli {
  async complete(prompt: string, opts?: LlmOptions): Promise<LlmResult> {
    const model = opts?.model ?? process.env.LLM_MODEL;
    if (!model) throw new Error('CodexCliAdapter requires opts.model or LLM_MODEL.');
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'devloop-codex-'));
    const outputPath = path.join(tempDirectory, 'last-message.json');
    const startedAt = performance.now();
    try {
      await runCliProcess('codex', [
        'exec',
        '--sandbox', 'read-only',
        '--ephemeral',
        '--output-last-message', outputPath,
        '-m', model,
        prompt,
      ], { timeoutMs: opts?.timeoutMs });
      const text = await readFile(outputPath, 'utf8');
      return { text, elapsedMs: performance.now() - startedAt };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}
