import type { LlmCli, LlmOptions, LlmResult } from './llm-cli';

export class CodexCliAdapter implements LlmCli {
  complete(_prompt: string, _opts?: LlmOptions): Promise<LlmResult> {
    return Promise.reject(new Error('CodexCliAdapter is a Phase 0 stub and cannot invoke an LLM.'));
  }
}
