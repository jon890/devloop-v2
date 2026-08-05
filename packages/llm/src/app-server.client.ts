import { JsonRpcTransport, LlmCompleteOptions, LlmCompleteResult } from "./llm.types";

const DEFAULT_CLIENT_NAME = "devloop";
const DEFAULT_CLIENT_VERSION = "0.0.0";
const DEFAULT_TIMEOUT_MS = 180_000;
/**
 * 턴 대기가 아니라 **요청·응답 한 쌍**의 제한 시간이다. `initialize` 0.00초·`thread/start` 0.14초
 * (ADR 0008 실측)에 비해 넉넉하다. 이 값이 없으면 서버가 죽은 순간 진행 중인 요청이 영원히 매달린다.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface AppServerClientOptions {
  cwd: string;
  clientName?: string;
  clientVersion?: string;
  defaultTimeoutMs?: number;
  /** 요청 하나가 응답을 기다리는 한계. 턴 대기(`defaultTimeoutMs`) 와 별개다. */
  requestTimeoutMs?: number;
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
    this.transport.onClose(() => this.handleTransportClosed());
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
    this.rejectPending(new Error("app-server 연결이 닫혀 진행 중인 LLM 호출이 취소되었다."));
    this.transport.close();
  }

  /**
   * 소켓이 끊긴 경우다. `close()` 와 달리 **클라이언트를 닫힌 상태로 만들지 않는다** —
   * 캐시를 남기면 첫 호출의 실패가 그 프로세스의 모든 후속 호출을 영구히 막으므로
   * `initialize` 캐시만 비워 다음 호출이 다시 시도하게 한다.
   *
   * **다만 재접속 로직은 없다.** 죽은 소켓의 `send()` 는 예외 없이 버려지므로 후속 호출은
   * 요청 제한 시간을 태운 뒤 거부된다 (`initialize`·`thread/start` 각 30초). 즉시 실패시키려면
   * 끊김 플래그를 세워 거절해야 하는데, 그건 재접속 가능성을 포기하는 설계 결정이라 남겨 두었다.
   */
  private handleTransportClosed(): void {
    this.initializing = undefined;
    this.rejectPending(new Error("app-server 연결이 끊겨 진행 중인 LLM 호출이 취소되었다."));
  }

  private rejectPending(error: Error): void {
    for (const request of this.pendingRequests.values()) {
      request.reject(error);
    }
    this.pendingRequests.clear();
    for (const turn of this.pendingTurns) {
      turn.reject(error);
    }
    this.pendingTurns.clear();
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initializing) {
      // `clientName` 은 구세대 형식이라 거부된다.
      const attempt = this.request("initialize", {
        clientInfo: {
          name: this.options.clientName ?? DEFAULT_CLIENT_NAME,
          version: this.options.clientVersion ?? DEFAULT_CLIENT_VERSION,
        },
      }).then(() => undefined);
      // 실패한 시도를 캐시로 남기면 후속 호출이 전부 같은 실패를 받는다.
      // 이미 다른 시도로 교체됐으면 건드리지 않는다.
      attempt.catch(() => {
        if (this.initializing === attempt) {
          this.initializing = undefined;
        }
      });
      this.initializing = attempt;
    }
    return this.initializing;
  }

  /**
   * 응답이 오지 않으면 제한 시간 뒤 거부한다. 턴 대기와 달리 이 구간은 `complete` 의 제한 시간
   * 밖이라, 여기서 재지 않으면 서버가 죽은 순간 `initialize`·`thread/start` 가 영원히 매달린다.
   */
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const pending: PendingRequest = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.pendingRequests.set(id, pending);
      timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        pending.reject(new Error(`${method} 요청이 ${requestTimeoutMs}ms 안에 응답하지 않았다.`));
      }, requestTimeoutMs);
      try {
        this.transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
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

  /**
   * `threadId` 로 갈라 낸다. 하나에 이어 붙이면 동시 호출의 본문이 섞인다.
   * 호출마다 새 thread 를 쓰므로(ADR 0008) 같은 thread 에 두 턴이 걸리지 않는다.
   * `findTurn` 의 `turnId` 비교는 그 전제가 깨질 때만 작동하는 방어적 검사다.
   */
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
