import { LlmCompleteOptions, LlmCompleteResult, LlmTransport } from "./llm.types";
import { ResponsesEndpoint } from "./responses.credentials";

const DEFAULT_TIMEOUT_MS = 180_000;
const RESPONSES_INSTRUCTIONS = "Follow the user's request and return only the final response.";
const OUTPUT_SCHEMA_NAME = "devloop_response";

type Fetch = typeof fetch;

export interface ResponsesTransportOptions {
  endpoint: () => ResponsesEndpoint;
  fetch?: Fetch;
  defaultTimeoutMs?: number;
}

interface ResponsesEvent {
  type?: unknown;
  delta?: unknown;
}

export function createResponsesTransport(options: ResponsesTransportOptions): LlmTransport {
  const request = options.fetch ?? fetch;
  return {
    async complete(prompt: string, opts: LlmCompleteOptions): Promise<LlmCompleteResult> {
      if (!opts?.model) {
        throw new Error("LLM 호출에 model이 필요하다. 기본 모델로 조용히 돌아가지 않는다 (ADR 0003).");
      }

      const startedAt = Date.now();
      const endpoint = options.endpoint();
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(endpoint.url, {
          method: "POST",
          headers: endpoint.headers,
          body: JSON.stringify(buildRequest(prompt, opts)),
          signal: controller.signal,
        });
        if (response.status === 401) {
          throw new Error("Codex 계정 인증이 만료되었다. codex를 한 번 실행해 토큰을 갱신하라.");
        }
        if (!response.ok) {
          throw new Error(`Responses 직접 호출이 실패했다 (HTTP ${response.status}).`);
        }
        if (!response.body) {
          throw new Error("Responses 직접 호출에 응답 스트림이 없다.");
        }

        const text = await readOutputText(response.body);
        if (text.length === 0) {
          throw new Error("Responses 직접 호출이 빈 응답을 반환했다.");
        }
        return { text, elapsedMs: Date.now() - startedAt };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`LLM 호출이 ${timeoutMs}ms 안에 끝나지 않았다.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async close(): Promise<void> {},
  };
}

function buildRequest(prompt: string, opts: LlmCompleteOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    instructions: RESPONSES_INSTRUCTIONS,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    stream: true,
    store: false,
  };
  if (opts.outputSchema) {
    body.text = { format: { type: "json_schema", name: OUTPUT_SCHEMA_NAME, strict: true, schema: opts.outputSchema } };
  }
  if (opts.effort) {
    body.reasoning = { effort: opts.effort };
  }
  return body;
}

async function readOutputText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;

    let event: ResponsesEvent;
    try {
      event = JSON.parse(data) as ResponsesEvent;
    } catch {
      throw new Error("Responses SSE 이벤트를 JSON으로 해석하지 못했다.");
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      output += event.delta;
      return;
    }
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error("Responses 스트림이 오류 이벤트를 반환했다.");
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer) consumeLine(buffer);
  return output;
}
