import { ChildProcess, spawn } from "node:child_process";
import { AppServerHandle } from "./llm.types";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 50;
const READY_PROBE_TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 2_000;
const LOG_TAIL_LINES = 40;

/**
 * 서버가 배정된 포트를 알려 준다. 포트를 직접 고르면 이미 쓰는 포트와 부딪힌다.
 *
 * **stdout·stderr 둘 다 훑는다.** codex-cli 0.146.0 은 이 배너를 stderr 로 쓴다 (실측: stdout 0바이트).
 * stdout 만 보면 접속 주소를 영원히 못 읽어 제한 시간 뒤 거부한다.
 */
const LISTENING_PATTERN = /listening on:\s*(ws:\/\/\S+)/;

export interface StartAppServerOptions {
  cwd: string;
  readyTimeoutMs?: number;
  /** 서버 stdout·stderr 를 버리지 않는다. 원인을 볼 곳이 이것뿐이다. */
  onLog?: (line: string) => void;
}

class LogTail {
  private readonly lines: string[] = [];
  private buffered = "";

  constructor(private readonly onLog?: (line: string) => void) {}

  push(chunk: string): string[] {
    this.buffered += chunk;
    const parts = this.buffered.split("\n");
    this.buffered = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > LOG_TAIL_LINES) {
        this.lines.shift();
      }
      this.onLog?.(line);
    }
    return parts;
  }

  text(): string {
    return this.lines.join("\n");
  }
}

async function probeReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS) });
    return response.status === 200;
  } catch {
    return false;
  }
}

function readyzUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  return `http://${parsed.host}/readyz`;
}

function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const grace = setTimeout(() => {
      child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(grace);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * `codex app-server` 를 자식으로 띄우고 준비를 확인한다.
 *
 * 제한 시간 안에 준비되지 않으면 **거부한다.** 서버 없이 뜬 API 는 모든 질의가 실패하므로
 * 부분 성공을 허용하면 늦게 드러날 뿐이다 (ADR 0003).
 */
export async function startAppServer(opts: StartAppServerOptions): Promise<AppServerHandle> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const logs = new LogTail(opts.onLog);
  const child = spawn("codex", ["app-server", "--listen", "ws://127.0.0.1:0"], {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // 종료 훅과 정상 경로 양쪽에서 불릴 수 있으므로 두 번 불려도 안전해야 한다.
    if (!closing) {
      closing = killChild(child);
    }
    return closing;
  };

  try {
    const url = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(`codex app-server 가 ${readyTimeoutMs}ms 안에 접속 주소를 알리지 않았다.\n${logs.text()}`));
      }, readyTimeoutMs);
      const finish = (settle: () => void) => {
        clearTimeout(deadline);
        settle();
      };
      const scan = (chunk: string): void => {
        for (const line of logs.push(chunk)) {
          const matched = LISTENING_PATTERN.exec(line);
          if (matched) {
            finish(() => resolve(matched[1]));
            return;
          }
        }
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.once("error", (error: Error) => finish(() => reject(error)));
      child.once("exit", (code, signal) => {
        finish(() => reject(new Error(`codex app-server 가 준비되기 전에 종료했다 (code=${code}, signal=${signal}).\n${logs.text()}`)));
      });
    });

    const ready = readyzUrl(url);
    const deadline = Date.now() + readyTimeoutMs;
    while (!(await probeReady(ready))) {
      if (Date.now() >= deadline) {
        throw new Error(`codex app-server 의 ${ready} 가 ${readyTimeoutMs}ms 안에 200 을 주지 않았다.\n${logs.text()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }

    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
