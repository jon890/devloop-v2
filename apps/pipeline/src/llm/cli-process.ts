import { spawn } from 'node:child_process';

export interface CliProcessResult {
  stdout: string;
  stderr: string;
}

export function runCliProcess(
  command: string,
  args: readonly string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    let settled = false;
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: controller.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs)
      : undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    child.on('error', (error) => {
      finish(timedOut
        ? new Error(`${command} timed out after ${options.timeoutMs}ms.`)
        : error);
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`${command} timed out after ${options.timeoutMs}ms.`));
      } else if (code !== 0) {
        finish(new Error(`${command} exited with code ${String(code)} signal=${String(signal)}: ${stderr.trim()}`));
      } else {
        finish();
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}
