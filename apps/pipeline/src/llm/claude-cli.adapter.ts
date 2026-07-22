import type { LlmCli, LlmOptions, LlmResult } from './llm-cli';
import { runCliProcess } from './cli-process';

interface ClaudeJsonResult {
  result?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

export class ClaudeCliAdapter implements LlmCli {
  async complete(prompt: string, opts?: LlmOptions): Promise<LlmResult> {
    const model = opts?.model ?? process.env.LLM_MODEL;
    if (!model) throw new Error('ClaudeCliAdapter requires opts.model or LLM_MODEL.');
    const startedAt = performance.now();
    const processResult = await runCliProcess(
      'claude',
      ['-p', '--output-format', 'json', '--model', model],
      { input: prompt, timeoutMs: opts?.timeoutMs },
    );
    let output: ClaudeJsonResult;
    try {
      output = JSON.parse(processResult.stdout) as ClaudeJsonResult;
    } catch {
      throw new Error(`Claude CLI returned invalid JSON: ${processResult.stdout.slice(0, 300)}`);
    }
    if (typeof output.result !== 'string') throw new Error('Claude CLI JSON did not contain a string result.');
    const inputTokens = output.usage?.input_tokens;
    const outputTokens = output.usage?.output_tokens;
    const tokens = Number.isInteger(inputTokens) && Number.isInteger(outputTokens)
      ? { in: inputTokens as number, out: outputTokens as number }
      : undefined;
    return { text: output.result, elapsedMs: performance.now() - startedAt, tokens };
  }
}
