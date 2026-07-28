import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";
import { LLM_REASONING_EFFORTS, type ApiConfig } from "../config";

export interface LlmOptions {
  timeoutMs?: number;
  model?: string;
  effort?: LlmReasoningEffort;
}

export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

export interface LlmResult {
  text: string;
  elapsedMs: number;
  tokens?: { in: number; out: number };
}

export interface LlmCli {
  complete(prompt: string, opts?: LlmOptions): Promise<LlmResult>;
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

@Injectable()
export class CodexCliAdapter extends ChildProcessCliAdapter {
  protected command(opts?: LlmOptions): { bin: string; args: string[] } {
    // effort 값 검증은 기동 시 환경설정 스키마가 한다.
    const effort = opts?.effort ?? this.config.llm.reasoningEffort;
    return {
      bin: "codex",
      args: ["exec", "-m", this.model(opts), ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : [])],
    };
  }
}

@Injectable()
export class ClaudeCliAdapter extends ChildProcessCliAdapter {
  protected command(opts?: LlmOptions): { bin: string; args: string[] } {
    return {
      bin: "claude",
      args: ["-p", "--model", this.model(opts)],
    };
  }
}

export function createLlmCli(config: ApiConfig): LlmCli {
  return config.llm.provider === "claude" ? new ClaudeCliAdapter(config) : new CodexCliAdapter(config);
}
