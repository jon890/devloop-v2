import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesTransport } from "./responses.client";

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status },
  );
}

function endpoint() {
  return { url: "https://example.test/responses", headers: { authorization: "Bearer secret" } };
}

test("스키마와 effort를 요청 계약에 싣는다", async () => {
  let body: Record<string, unknown> | undefined;
  const transport = createResponsesTransport({
    endpoint,
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return streamResponse(['data: {"type":"response.output_text.delta","delta":"ok"}\n', "data: [DONE]\n"]);
    },
  });
  const outputSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

  await transport.complete("prompt", { model: "gpt-5.6-terra", effort: "high", outputSchema });

  assert.equal(body?.stream, true);
  assert.equal(body?.store, false);
  assert.deepEqual(body?.reasoning, { effort: "high" });
  assert.deepEqual(body?.text, { format: { type: "json_schema", name: "devloop_response", strict: true, schema: outputSchema } });
  assert.deepEqual(body?.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "prompt" }] }]);
});

test("스키마와 effort가 없으면 요청 키도 싣지 않는다", async () => {
  let body: Record<string, unknown> | undefined;
  const transport = createResponsesTransport({
    endpoint,
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return streamResponse(['data: {"type":"response.output_text.delta","delta":"ok"}\n']);
    },
  });

  await transport.complete("prompt", { model: "model" });
  assert.equal("text" in (body ?? {}), false);
  assert.equal("reasoning" in (body ?? {}), false);
});

test("SSE 줄이 청크 중간에서 끊겨도 delta를 조립하고 알 수 없는 이벤트와 DONE을 건너뛴다", async () => {
  const transport = createResponsesTransport({
    endpoint,
    fetch: async () =>
      streamResponse([
        'data: {"type":"response.output_',
        'text.delta","delta":"앞"}\ndata: {"type":"unknown","delta":"무시"}\n',
        'data: {"type":"response.output_text.delta","delta":"뒤"}\ndata: [DO',
        "NE]\n",
      ]),
  });

  assert.equal((await transport.complete("prompt", { model: "model" })).text, "앞뒤");
});

test("401은 Codex 토큰 갱신 안내와 함께 실패한다", async () => {
  const transport = createResponsesTransport({ endpoint, fetch: async () => streamResponse([], 401) });
  await assert.rejects(transport.complete("prompt", { model: "model" }), /codex.*토큰.*갱신/);
});

test("400 error body는 bounded read로 안전한 type과 code만 실패 메시지에 포함한다", async () => {
  let cancelled = false;
  let pulls = 0;
  const encoder = new TextEncoder();
  const firstChunk = JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "invalid_json_schema",
      message: `SECRET_SOURCE_TEXT ${"x".repeat(20_000)}`,
      prompt: "SECRET_SOURCE_TEXT",
    },
  });
  const transport = createResponsesTransport({
    endpoint,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(encoder.encode(firstChunk));
            controller.enqueue(encoder.encode("SECRET_SOURCE_TEXT".repeat(1000)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 400 },
      ),
  });

  await assert.rejects(
    transport.complete("prompt", { model: "model" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("type=invalid_request_error") &&
      error.message.includes("code=invalid_json_schema") &&
      !error.message.includes("message=") &&
      !error.message.includes("SECRET_SOURCE_TEXT") &&
      cancelled &&
      pulls <= 1,
  );
});

test("오류 이벤트와 빈 응답을 실패로 올린다", async () => {
  const failed = createResponsesTransport({
    endpoint,
    fetch: async () => streamResponse(['data: {"type":"response.failed"}\n']),
  });
  await assert.rejects(failed.complete("prompt", { model: "model" }), /오류 이벤트/);

  const empty = createResponsesTransport({ endpoint, fetch: async () => streamResponse(["data: [DONE]\n"]) });
  await assert.rejects(empty.complete("prompt", { model: "model" }), /빈 응답/);
});

test("시간 초과는 요청을 중단하고 실패한다", async () => {
  const transport = createResponsesTransport({
    endpoint,
    fetch: async (_input, init) => {
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      throw new Error("unreachable");
    },
  });
  await assert.rejects(transport.complete("prompt", { model: "model", timeoutMs: 10 }), /10ms/);
});
