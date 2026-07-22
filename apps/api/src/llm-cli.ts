import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';

export interface LlmOptions {
  timeoutMs?: number;
  model?: string;
}

export interface LlmResult {
  text: string;
  elapsedMs: number;
  tokens?: { in: number; out: number };
}

export interface LlmCli {
  complete(prompt: string, opts?: LlmOptions): Promise<LlmResult>;
}

export const LLM_CLI = Symbol('LLM_CLI');

abstract class ChildProcessCliAdapter implements LlmCli {
  protected abstract command(opts?: LlmOptions): { bin: string; args: string[] };

  complete(prompt: string, opts: LlmOptions = {}): Promise<LlmResult> {
    const started = Date.now();
    const { bin, args } = this.command(opts);
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let stdout = '';
    let stderr = '';
    let settled = false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on('close', (code) => {
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
    const model = opts?.model ?? process.env.LLM_MODEL;
    return { bin: 'codex', args: ['exec', ...(model ? ['-m', model] : [])] };
  }
}

@Injectable()
export class ClaudeCliAdapter extends ChildProcessCliAdapter {
  protected command(opts?: LlmOptions): { bin: string; args: string[] } {
    const model = opts?.model ?? process.env.LLM_MODEL;
    return { bin: 'claude', args: ['-p', ...(model ? ['--model', model] : [])] };
  }
}

export function createLlmCli(): LlmCli {
  return process.env.LLM_PROVIDER === 'claude' ? new ClaudeCliAdapter() : new CodexCliAdapter();
}
