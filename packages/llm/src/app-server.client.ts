import { JsonRpcTransport, LlmCompleteOptions, LlmCompleteResult } from "./llm.types";

const DEFAULT_CLIENT_NAME = "devloop";
const DEFAULT_CLIENT_VERSION = "0.0.0";
const DEFAULT_TIMEOUT_MS = 180_000;

export interface AppServerClientOptions {
  cwd: string;
  clientName?: string;
  clientVersion?: string;
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

interface PendingTurn {
  threadId: string;
  turnId?: string;
  chunks: string[];
  resolve(text: string): void;
  reject(error: Error): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * `codex app-server` 의 JSON-RPC 규칙만 안다. 무엇을 물어볼지도, 서버를 어떻게 띄우는지도 모른다.
 *
 * 이 계층에서 틀리기 쉬운 두 가지를 여기에 가둔다.
 * - 완료는 `turn/start` 응답이 아니라 `turn/completed` 알림으로 온다
 * - 실패도 JSON-RPC 오류가 아니라 그 알림의 `turn.status` 로 온다
 */
export class AppServerClient {
  private readonly transport: JsonRpcTransport;
  private readonly options: AppServerClientOptions;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Set<PendingTurn>();
  private nextRequestId = 1;
  private initializing?: Promise<void>;
  private closed = false;

  constructor(transport: JsonRpcTransport, options: AppServerClientOptions) {
    this.transport = transport;
    this.options = options;
    this.transport.onMessage((message) => this.handleMessage(message));
  }

  async complete(prompt: string, opts: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const startedAt = Date.now();
    if (!opts || !opts.model) {
      throw new Error("LLM 호출에 model 이 필요하다. 기본 모델로 조용히 돌아가지 않는다 (ADR 0003).");
    }
    if (this.closed) {
      throw new Error("app-server 클라이언트가 이미 닫혔다.");
    }

    await this.ensureInitialized();

    const threadResult = asRecord(
      await this.request("thread/start", {
        model: opts.model,
        cwd: this.options.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
      }),
    );
    const threadId = asString(asRecord(threadResult?.thread)?.id);
    if (!threadId) {
      throw new Error("thread/start 응답에 thread.id 가 없다.");
    }

    // 알림이 `turn/start` 응답보다 먼저 올 수 있으므로 보내기 전에 등록한다.
    let settle: PendingTurn | undefined;
    const completion = new Promise<string>((resolve, reject) => {
      settle = { threadId, chunks: [], resolve, reject };
      this.pendingTurns.add(settle);
    });
    const pending = settle as PendingTurn;

    const timeoutMs = opts.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // 정리 없이 거부하면 서버에 턴이 남는다.
        this.interrupt(pending);
        reject(new Error(`LLM 호출이 ${timeoutMs}ms 안에 끝나지 않았다.`));
      }, timeoutMs);
    });

    try {
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: "text", text: prompt }],
        model: opts.model,
      };
      if (opts.effort) {
        turnParams.effort = opts.effort;
      }
      // 응답 형식을 프롬프트로 부탁하는 대신 서버에 규격으로 넘긴다.
      // 계약이 없는 호출에는 키를 아예 싣지 않는다 (`effort` 와 같은 규칙).
      if (opts.outputSchema) {
        turnParams.outputSchema = opts.outputSchema;
      }
      const turnResult = asRecord(await this.request("turn/start", turnParams));
      pending.turnId = asString(asRecord(turnResult?.turn)?.id);

      const text = await Promise.race([completion, timeout]);
      return { text, elapsedMs: Date.now() - startedAt };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      this.pendingTurns.delete(pending);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error("app-server 연결이 닫혀 진행 중인 LLM 호출이 취소되었다.");
    for (const request of this.pendingRequests.values()) {
      request.reject(error);
    }
    this.pendingRequests.clear();
    for (const turn of this.pendingTurns) {
      turn.reject(error);
    }
    this.pendingTurns.clear();
    this.transport.close();
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initializing) {
      // `clientName` 은 구세대 형식이라 거부된다.
      this.initializing = this.request("initialize", {
        clientInfo: {
          name: this.options.clientName ?? DEFAULT_CLIENT_NAME,
          version: this.options.clientVersion ?? DEFAULT_CLIENT_VERSION,
        },
      }).then(() => undefined);
      this.initializing.catch(() => {
        this.initializing = undefined;
      });
    }
    return this.initializing;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private interrupt(turn: PendingTurn): void {
    if (!turn.turnId) {
      return;
    }
    this.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId }).catch(() => undefined);
  }

  private handleMessage(message: unknown): void {
    const payload = asRecord(message);
    if (!payload) {
      return;
    }
    if (typeof payload.id === "number" && ("result" in payload || "error" in payload)) {
      const pending = this.pendingRequests.get(payload.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(payload.id);
      const error = asRecord(payload.error);
      if (error) {
        pending.reject(new Error(asString(error.message) ?? "JSON-RPC 오류"));
        return;
      }
      pending.resolve(payload.result);
      return;
    }

    const method = asString(payload.method);
    if (method === "item/agentMessage/delta") {
      this.handleDelta(asRecord(payload.params));
      return;
    }
    if (method === "turn/completed") {
      this.handleCompleted(asRecord(payload.params));
    }
  }

  /** `threadId`·`turnId` 로 갈라 낸다. 하나에 이어 붙이면 동시 호출의 본문이 섞인다. */
  private handleDelta(params: Record<string, unknown> | undefined): void {
    const delta = asString(params?.delta);
    if (delta === undefined) {
      return;
    }
    const turn = this.findTurn(asString(params?.threadId), asString(params?.turnId));
    turn?.chunks.push(delta);
  }

  private handleCompleted(params: Record<string, unknown> | undefined): void {
    const completed = asRecord(params?.turn);
    const turn = this.findTurn(asString(params?.threadId), asString(completed?.id));
    if (!turn) {
      return;
    }
    this.pendingTurns.delete(turn);
    const status = asString(completed?.status);
    if (status !== "completed") {
      const message = asString(asRecord(completed?.error)?.message) ?? "원인 없음";
      turn.reject(new Error(`LLM 턴이 실패했다 (status=${status ?? "unknown"}): ${message}`));
      return;
    }
    turn.resolve(turn.chunks.join(""));
  }

  private findTurn(threadId: string | undefined, turnId: string | undefined): PendingTurn | undefined {
    if (!threadId) {
      return undefined;
    }
    for (const turn of this.pendingTurns) {
      if (turn.threadId !== threadId) {
        continue;
      }
      if (turn.turnId && turnId && turn.turnId !== turnId) {
        continue;
      }
      return turn;
    }
    return undefined;
  }
}
