import { AppServerClient } from "./app-server.client";
import { startAppServer } from "./app-server.process";
import { AppServerHandle, JsonRpcTransport, LlmCompleteOptions, LlmCompleteResult, LlmTransport } from "./llm.types";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface AppServerLlmTransportOptions {
  cwd: string;
  readyTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** 호출 하나의 제한 시간. `complete` 의 `timeoutMs` 가 우선한다. */
  defaultTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  onLog?: (line: string) => void;
}

/** WebSocket 은 Node 전역이다. 이 패키지는 런타임 의존을 추가하지 않는다. */
export function connectWebSocketTransport(url: string, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<JsonRpcTransport> {
  return new Promise<JsonRpcTransport>((resolve, reject) => {
    const socket = new WebSocket(url);
    const handlers: ((message: unknown) => void)[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${url} 에 ${connectTimeoutMs}ms 안에 접속하지 못했다.`));
    }, connectTimeoutMs);

    socket.addEventListener("message", (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      for (const handler of handlers) {
        handler(parsed);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${url} 접속이 실패했다.`));
    });
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        onMessage: (handler: (message: unknown) => void) => handlers.push(handler),
        close: () => socket.close(),
      });
    });
  });
}

/**
 * 상주 `codex app-server` 로 LLM 호출을 보내는 어댑터다.
 *
 * **어댑터가 서버 handle 을 소유한다.** 호출자에게 handle 을 따로 돌려주면 보관을 빠뜨려도
 * 컴파일이 통과하고, 서버를 죽일 대상이 사라진다.
 */
export class AppServerLlmTransport implements LlmTransport {
  private closing?: Promise<void>;

  private constructor(
    private readonly handle: AppServerHandle,
    private readonly client: AppServerClient,
  ) {}

  static async start(options: AppServerLlmTransportOptions): Promise<AppServerLlmTransport> {
    const handle = await startAppServer({ cwd: options.cwd, readyTimeoutMs: options.readyTimeoutMs, onLog: options.onLog });
    try {
      const transport = await connectWebSocketTransport(handle.url, options.connectTimeoutMs);
      const client = new AppServerClient(transport, {
        cwd: options.cwd,
        clientName: options.clientName,
        clientVersion: options.clientVersion,
        defaultTimeoutMs: options.defaultTimeoutMs,
      });
      return new AppServerLlmTransport(handle, client);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  complete(prompt: string, opts: LlmCompleteOptions): Promise<LlmCompleteResult> {
    return this.client.complete(prompt, opts);
  }

  /** 두 번 불려도 안전하다. 호출자가 종료 훅과 정상 경로 양쪽에서 부를 수 있다. */
  close(): Promise<void> {
    if (!this.closing) {
      this.client.close();
      this.closing = this.handle.close();
    }
    return this.closing;
  }
}
