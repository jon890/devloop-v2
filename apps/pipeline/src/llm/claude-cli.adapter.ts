import type { LlmCli, LlmOptions, LlmResult } from './llm-cli';

export class ClaudeCliAdapter implements LlmCli {
  complete(_prompt: string, _opts?: LlmOptions): Promise<LlmResult> {
    return Promise.reject(new Error('ClaudeCliAdapter is a Phase 0 stub and cannot invoke an LLM.'));
  }
}
