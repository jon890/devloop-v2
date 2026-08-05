import { AppServerLlmTransport } from "@devloop/llm";
import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";
import { LLM_REASONING_EFFORTS, REPO_ROOT, type ApiConfig } from "../config";

/** 상주 어댑터가 쓰는 호출 제한 시간. 자식 프로세스 어댑터의 기존 값과 같게 둔다. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface LlmOptions {
  timeoutMs?: number;
  model?: string;
  effort?: LlmReasoningEffort;
  /** 응답 형식 계약. 상주 어댑터만 서버에 넘긴다. 자식 프로세스 CLI 에는 실을 통로가 없다. */
  outputSchema?: Record<string, unknown>;
}

export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

export interface LlmResult {
  text: string;
  elapsedMs: number;
  tokens?: { in: number; out: number };
}

export interface LlmCli {
  complete(prompt: string, opts?: LlmOptions): Promise<LlmResult>;
  /**
   * 상주 어댑터만 구현한다. 호출자는 `await cli.close?.()` 로 부르므로 provider 분기가 필요 없다.
   */
  close?(): Promise<void>;
}

export const LLM_CLI = Symbol("LLM_CLI");

abstract class ChildProcessCliAdapter implements LlmCli {
  constructor(protected readonly config: ApiConfig) {}

  protected abstract command(opts?: LlmOptions): {
    bin: string;
    args: string[];
  };

  /** opts.model 이 환경설정보다 우선한다. 설정값은 필수라 항상 채워져 있다. */
  protected model(opts?: LlmOptions): string {
    return opts?.model || this.config.llm.queryModel;
  }

  complete(prompt: string, opts: LlmOptions = {}): Promise<LlmResult> {
    const started = Date.now();
    const { bin, args } = this.command(opts);
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let stdout = "";
    let stderr = "";
    let settled = false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGTERM");
          reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ text: stdout.trim(), elapsedMs: Date.now() - started });
          return;
        }
        reject(new Error(`${bin} exited with code ${code}: ${stderr.trim()}`));
      });

      child.stdin.end(prompt);
    });
  }
}

/**
 * `outputSchema` 를 실을 통로가 없다. 이 공급자는 응답 형식 계약을 서버에 넘기지 못한다.
 *
 * 프롬프트의 형식 지시도 함께 없앴으므로 형식 위반은 `completeStructured` 의 zod 검증이 잡는다.
 * 재시도가 없어졌으니 위반은 조용히 넘어가지 않고 즉시 오류가 된다 — 계약 결함을 드러내는 것이 의도다.
 */
@Injectable()
export class ClaudeCliAdapter extends ChildProcessCliAdapter {
  protected command(opts?: LlmOptions): { bin: string; args: string[] } {
    return {
      bin: "claude",
      args: ["-p", "--model", this.model(opts)],
    };
  }
}

/**
 * 상주 `codex app-server` 로 질의를 보내는 어댑터다.
 *
 * 서버 handle 은 `AppServerLlmTransport` 가 소유하므로 이 어댑터는 `close()` 만 위임한다.
 */
export class AppServerCliAdapter implements LlmCli {
  private constructor(
    private readonly transport: AppServerLlmTransport,
    private readonly config: ApiConfig,
  ) {}

  /** 기동 시 부른다. 준비 확인이 실패하면 거부해 API 기동을 함께 실패시킨다. */
  static async start(config: ApiConfig): Promise<AppServerCliAdapter> {
    const transport = await AppServerLlmTransport.start({
      cwd: REPO_ROOT,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      clientName: "devloop-api",
      onLog: (line) => console.log(`[codex app-server] ${line}`),
    });
    return new AppServerCliAdapter(transport, config);
  }

  async complete(prompt: string, opts: LlmOptions = {}): Promise<LlmResult> {
    // effort 값 검증은 기동 시 환경설정 스키마가 한다.
    const result = await this.transport.complete(prompt, {
      model: opts.model || this.config.llm.queryModel,
      effort: opts.effort ?? this.config.llm.reasoningEffort,
      timeoutMs: opts.timeoutMs,
      outputSchema: opts.outputSchema,
    });
    return { text: result.text.trim(), elapsedMs: result.elapsedMs };
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

/**
 * `claude` 는 자식 프로세스 어댑터를 그대로 쓰고, 그 밖은 상주 어댑터를 준다.
 * 상주 어댑터는 서버 기동을 기다리므로 비동기다 — Nest 의 `useFactory` 가 Promise 를 받는다.
 */
export function createLlmCli(config: ApiConfig): LlmCli | Promise<LlmCli> {
  return config.llm.provider === "claude" ? new ClaudeCliAdapter(config) : AppServerCliAdapter.start(config);
}
