import { chatgptAccountEndpoint, createResponsesTransport, type LlmTransport } from "@devloop/llm";
import { LlmOptionsSchema, type LlmCli, type LlmOptions, type LlmResult } from "./llm-cli";

/** Responses 엔드포인트로 직접 보내며 자식 프로세스를 소유하지 않는다. */
export class ResponsesCliAdapter implements LlmCli {
  private readonly transport: LlmTransport;

  constructor(transport?: LlmTransport) {
    this.transport = transport ?? createResponsesTransport({ endpoint: chatgptAccountEndpoint });
  }

  async complete(prompt: string, opts?: LlmOptions): Promise<LlmResult> {
    const parsedOptions = LlmOptionsSchema.parse(opts ?? {});
    if (!parsedOptions.model) {
      throw new Error("ResponsesCliAdapter requires opts.model or LLM_MODEL.");
    }
    const result = await this.transport.complete(prompt, {
      model: parsedOptions.model,
      effort: parsedOptions.effort,
      timeoutMs: parsedOptions.timeoutMs,
      outputSchema: parsedOptions.outputSchema,
    });
    return { text: result.text, elapsedMs: result.elapsedMs };
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
