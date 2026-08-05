import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClient } from "./app-server.client";
import { JsonRpcTransport } from "./llm.types";

interface SentMessage {
  id?: number;
  method: string;
  params: Record<string, unknown>;
}

/** 프로토콜을 실제 서버 없이 검증한다. 서버를 띄우면 검증 대상이 프로토콜이 아니라 네트워크가 된다. */
class FakeAppServer implements JsonRpcTransport {
  readonly sent: SentMessage[] = [];
  readonly threadIds: string[] = [];
  readonly turnIds: string[] = [];
  closeCount = 0;
  private readonly handlers: ((message: unknown) => void)[] = [];
  private nextId = 1;

  send(message: unknown): void {
    const request = message as SentMessage;
    this.sent.push(request);
    if (request.method === "initialize") {
      this.reply(request, {});
      return;
    }
    if (request.method === "thread/start") {
      const threadId = `thread-${this.nextId++}`;
      this.threadIds.push(threadId);
      this.reply(request, { thread: { id: threadId } });
      return;
    }
    if (request.method === "turn/start") {
      const turnId = `turn-${this.nextId++}`;
      this.turnIds.push(turnId);
      this.reply(request, { turn: { id: turnId, status: "inProgress", items: [] } });
    }
  }

  onMessage(handler: (message: unknown) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.closeCount += 1;
  }

  requests(method: string): SentMessage[] {
    return this.sent.filter((message) => message.method === method);
  }

  emitDelta(threadId: string, turnId: string, delta: string): void {
    this.notify("item/agentMessage/delta", { threadId, turnId, itemId: "item-1", delta });
  }

  emitCompleted(threadId: string, turnId: string, status: string, message?: string): void {
    const turn: Record<string, unknown> = { id: turnId, status, items: [] };
    if (message) {
      turn.error = { message };
    }
    this.notify("turn/completed", { threadId, turn });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    for (const handler of this.handlers) {
      handler({ jsonrpc: "2.0", method, params });
    }
  }

  private reply(request: SentMessage, result: Record<string, unknown>): void {
    queueMicrotask(() => {
      for (const handler of this.handlers) {
        handler({ jsonrpc: "2.0", id: request.id, result });
      }
    });
  }
}

function newClient(server: FakeAppServer): AppServerClient {
  return new AppServerClient(server, { cwd: "/tmp/devloop-llm-test" });
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`조건이 만족되지 않았다: ${label}`);
}

function settled<T>(promise: Promise<T>): { isSettled: () => boolean } {
  let isSettled = false;
  promise.then(
    () => {
      isSettled = true;
    },
    () => {
      isSettled = true;
    },
  );
  return { isSettled: () => isSettled };
}

test("delta를 이어 붙여 본문을 만들고 turn/completed로 완료를 판정한다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  const pending = client.complete("질문", { model: "gpt-5.6-terra", effort: "high" });
  await waitFor(() => server.turnIds.length === 1, "turn/start 호출");
  server.emitDelta("thread-1", "turn-2", "앞");
  server.emitDelta("thread-1", "turn-2", "뒤");
  server.emitCompleted("thread-1", "turn-2", "completed");

  const result = await pending;
  assert.equal(result.text, "앞뒤");
  assert.ok(result.elapsedMs >= 0);

  const initialize = server.requests("initialize")[0];
  assert.deepEqual(initialize.params.clientInfo, { name: "devloop", version: "0.0.0" });
  const turnStart = server.requests("turn/start")[0];
  assert.equal(turnStart.params.threadId, "thread-1");
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "질문" }]);
  assert.equal(turnStart.params.model, "gpt-5.6-terra");
  assert.equal(turnStart.params.effort, "high");
});

test("turn/start 응답만 오고 turn/completed가 없으면 완료로 판정하지 않는다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  const pending = client.complete("질문", { model: "m" });
  const watcher = settled(pending);
  await waitFor(() => server.turnIds.length === 1, "turn/start 호출");
  server.emitDelta("thread-1", "turn-2", "본문");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(watcher.isSettled(), false, "turn/completed 없이 완료로 판정하면 실패를 성공으로 읽는다");

  server.emitCompleted("thread-1", "turn-2", "completed");
  assert.equal((await pending).text, "본문");
});

test("turn.status가 failed면 turn.error를 담아 거부한다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  const pending = client.complete("질문", { model: "m" });
  await waitFor(() => server.turnIds.length === 1, "turn/start 호출");
  server.emitDelta("thread-1", "turn-2", "부분 응답");
  server.emitCompleted("thread-1", "turn-2", "failed", "usage limit exceeded");

  await assert.rejects(pending, /status=failed.*usage limit exceeded/);
});

test("다른 threadId의 delta가 섞여 들어와도 동시 호출의 본문이 오염되지 않는다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  const first = client.complete("첫 질문", { model: "m" });
  await waitFor(() => server.turnIds.length === 1, "첫 turn/start");
  const second = client.complete("둘째 질문", { model: "m" });
  await waitFor(() => server.turnIds.length === 2, "둘째 turn/start");

  const [firstThread, secondThread] = server.threadIds;
  const [firstTurn, secondTurn] = server.turnIds;
  server.emitDelta(firstThread, firstTurn, "첫-");
  server.emitDelta(secondThread, secondTurn, "둘째-");
  server.emitDelta("thread-없음", "turn-없음", "남의 응답");
  server.emitDelta(firstThread, firstTurn, "본문");
  server.emitDelta(secondThread, secondTurn, "본문");
  server.emitCompleted(firstThread, firstTurn, "completed");
  server.emitCompleted(secondThread, secondTurn, "completed");

  assert.equal((await first).text, "첫-본문");
  assert.equal((await second).text, "둘째-본문");
});

test("호출마다 새 thread를 쓴다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  for (const prompt of ["첫 질문", "둘째 질문"]) {
    const pending = client.complete(prompt, { model: "m" });
    const index = server.turnIds.length;
    await waitFor(() => server.turnIds.length === index + 1, "turn/start 호출");
    server.emitCompleted(server.threadIds[index], server.turnIds[index], "completed");
    await pending;
  }

  assert.equal(server.requests("thread/start").length, 2);
  assert.equal(new Set(server.threadIds).size, 2);
  assert.equal(server.requests("initialize").length, 1);
});

test("thread/start가 sandbox read-only와 approvalPolicy never를 넘긴다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  const pending = client.complete("질문", { model: "gpt-5.5" });
  await waitFor(() => server.turnIds.length === 1, "turn/start 호출");
  server.emitCompleted("thread-1", "turn-2", "completed");
  await pending;

  assert.deepEqual(server.requests("thread/start")[0].params, {
    model: "gpt-5.5",
    cwd: "/tmp/devloop-llm-test",
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
  });
});

// 응답 형식 계약은 프롬프트가 아니라 이 params 로 서버에 전달된다. 호출자 쪽 테스트는
// `complete` 인자까지만 보호하므로, `turn/start` 까지 실리는지는 여기서만 회귀를 잡는다.
test("outputSchema를 turn/start에 실어 보내고, 없으면 키를 싣지 않는다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);
  const outputSchema = { type: "object", properties: { cypher: { type: "string" } }, required: ["cypher"] };

  const withSchema = client.complete("질문", { model: "m", outputSchema });
  await waitFor(() => server.turnIds.length === 1, "첫 turn/start");
  server.emitCompleted(server.threadIds[0], server.turnIds[0], "completed");
  await withSchema;

  const withoutSchema = client.complete("질문", { model: "m" });
  await waitFor(() => server.turnIds.length === 2, "둘째 turn/start");
  server.emitCompleted(server.threadIds[1], server.turnIds[1], "completed");
  await withoutSchema;

  const [first, second] = server.requests("turn/start");
  assert.deepEqual(first.params.outputSchema, outputSchema);
  assert.equal("outputSchema" in second.params, false, "계약이 없는 호출에는 키를 싣지 않는다");
});

test("model이 없으면 호출을 거부한다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  await assert.rejects(client.complete("질문", {} as never), /model/);
  await assert.rejects(client.complete("질문", { model: "" }), /model/);
  assert.equal(server.sent.length, 0);
});

test("시간이 초과되면 turn/interrupt를 보낸 뒤 거부한다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  const pending = client.complete("질문", { model: "m", timeoutMs: 30 });
  await assert.rejects(pending, /30ms/);

  const interrupt = server.requests("turn/interrupt");
  assert.equal(interrupt.length, 1);
  assert.deepEqual(interrupt[0].params, { threadId: "thread-1", turnId: "turn-2" });
});

test("close가 진행 중인 호출을 거부하고 전송을 닫는다", async () => {
  const server = new FakeAppServer();
  const client = newClient(server);

  const pending = client.complete("질문", { model: "m" });
  await waitFor(() => server.turnIds.length === 1, "turn/start 호출");
  client.close();
  client.close();

  await assert.rejects(pending, /닫혀/);
  assert.equal(server.closeCount, 1);
});
