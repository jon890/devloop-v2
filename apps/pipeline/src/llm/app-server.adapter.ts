import { AppServerLlmTransport, type LlmTransport } from "@devloop/llm";
import { LlmOptionsSchema, type LlmCli, type LlmOptions, type LlmResult } from "./llm-cli";

/**
 * 상주 `codex app-server` 로 추출 호출을 보내는 어댑터다.
 *
 * 서버 handle 은 `AppServerLlmTransport` 가 소유한다. 호출자는 `close()` 만 부르면 된다.
 */
export class AppServerCliAdapter implements LlmCli {
  constructor(private readonly transport: LlmTransport) {}

  /** 단계 시작에 한 번 부른다. 호출마다 띄우면 상주의 이득이 사라진다. */
  static async start(cwd: string): Promise<AppServerCliAdapter> {
    const transport = await AppServerLlmTransport.start({
      cwd,
      clientName: "devloop-pipeline",
      onLog: (line) => console.log(`[codex app-server] ${line}`),
    });
    return new AppServerCliAdapter(transport);
  }

  async complete(prompt: string, opts?: LlmOptions): Promise<LlmResult> {
    const parsedOptions = LlmOptionsSchema.parse(opts ?? {});
    if (!parsedOptions.model) {
      throw new Error("AppServerCliAdapter requires opts.model or LLM_MODEL.");
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
