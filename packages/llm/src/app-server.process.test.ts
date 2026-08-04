import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAppServer } from "./app-server.process";

/** 실제 codex 를 부르는 테스트는 구독 계정과 네트워크에 의존해 재현되지 않는다. 가짜 실행 파일로 검증한다. */
const READY_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const server = http.createServer((request, response) => {
  if (request.url === "/readyz") {
    response.writeHead(200).end("ok");
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(process.env.DEVLOOP_LLM_PID_FILE, String(process.pid));
  const port = server.address().port;
  process.stdout.write("codex app-server (WebSockets)\\n");
  process.stdout.write("  listening on: ws://127.0.0.1:" + port + "\\n");
  process.stdout.write("  readyz: http://127.0.0.1:" + port + "/readyz\\n");
});
`;

/** 접속 주소는 알리지만 readyz 가 응답하지 않는 서버다. 포트 1 은 연결이 거부된다. */
const NEVER_READY_FAKE = `#!/usr/bin/env node
process.stdout.write("  listening on: ws://127.0.0.1:1\\n");
process.stderr.write("readyz 를 열지 않는다\\n");
setInterval(() => {}, 1000);
`;

async function withFakeCodex(source: string, run: (context: { cwd: string; pidFile: string }) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devloop-llm-process-test-"));
  const codexPath = path.join(temporary, "codex");
  const pidFile = path.join(temporary, "pid");
  await writeFile(codexPath, source, "utf8");
  await chmod(codexPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${temporary}:${previousPath}`;
  process.env.DEVLOOP_LLM_PID_FILE = pidFile;
  try {
    await run({ cwd: temporary, pidFile });
  } finally {
    process.env.PATH = previousPath;
    delete process.env.DEVLOOP_LLM_PID_FILE;
    await rm(temporary, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("stdout의 listening 줄에서 접속 주소를 읽고 readyz를 확인한다", async () => {
  await withFakeCodex(READY_FAKE, async ({ cwd, pidFile }) => {
    const logs: string[] = [];
    const handle = await startAppServer({ cwd, readyTimeoutMs: 5_000, onLog: (line) => logs.push(line) });

    assert.match(handle.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(handle.url).port, "0", "포트를 0으로 맡기면 서버가 배정 결과를 알려 준다");
    assert.ok(
      logs.some((line) => line.includes("codex app-server (WebSockets)")),
      "서버 로그를 버리지 않는다",
    );

    const pid = Number(await readFile(pidFile, "utf8"));
    assert.equal(isAlive(pid), true);

    await handle.close();
    await handle.close();
    assert.equal(isAlive(pid), false, "close가 자식 프로세스를 죽여야 한다");
  });
});

test("readyz가 응답하지 않으면 제한 시간 뒤 거부하고 자식을 죽인다", async () => {
  await withFakeCodex(NEVER_READY_FAKE, async ({ cwd }) => {
    await assert.rejects(startAppServer({ cwd, readyTimeoutMs: 2_000 }), /readyz.*200/s);
  });
});

test("접속 주소를 알리지 않으면 제한 시간 뒤 거부한다", async () => {
  await withFakeCodex("#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", async ({ cwd }) => {
    await assert.rejects(startAppServer({ cwd, readyTimeoutMs: 200 }), /접속 주소/);
  });
});

test("서버가 준비 전에 종료하면 거부한다", async () => {
  await withFakeCodex('#!/usr/bin/env node\nprocess.stderr.write("boom\\n");\nprocess.exit(3);\n', async ({ cwd }) => {
    await assert.rejects(startAppServer({ cwd, readyTimeoutMs: 5_000 }), /준비되기 전에 종료했다 \(code=3/);
  });
});
