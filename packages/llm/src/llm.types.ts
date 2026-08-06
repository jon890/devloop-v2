/** JSON-RPC 메시지를 주고받는 통로. WebSocket 구현과 테스트용 메모리 구현이 이 계약을 만족한다. */
export interface JsonRpcTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  /**
   * 통로가 끊겼음을 알린다. **이 통보가 없으면 진행 중인 호출이 영원히 매달린다** —
   * 서버가 죽어도 응답이 안 올 뿐이라 대기 중인 Promise 를 깨울 신호가 없다.
   */
  onClose(handler: () => void): void;
  close(): void;
}

/** 자식으로 띄운 `codex app-server` 하나를 가리킨다. */
export interface AppServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/** Codex 구독 계정으로 사용할 수 있는 전송. 기본값은 호출자가 정한다. */
export const CODEX_LLM_TRANSPORTS = ["responses", "app-server"] as const;
export type CodexLlmTransport = (typeof CODEX_LLM_TRANSPORTS)[number];

export interface LlmCompleteOptions {
  /** 필수다. 빠지면 CLI 기본 모델로 조용히 돌아가는 사고가 있었다 (ADR 0003). */
  model: string;
  effort?: string;
  timeoutMs?: number;
  /** 응답 형식 계약. `turn/start` 의 `outputSchema` 로 그대로 실린다. 없으면 키를 싣지 않는다. */
  outputSchema?: Record<string, unknown>;
}

export interface LlmCompleteResult {
  text: string;
  elapsedMs: number;
}

/** 호출자가 들고 다니는 것은 이것 하나다. `close()` 는 자기가 띄운 서버와 전송을 함께 닫는다. */
export interface LlmTransport {
  complete(prompt: string, opts: LlmCompleteOptions): Promise<LlmCompleteResult>;
  close(): Promise<void>;
}
