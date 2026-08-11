import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chatgptAccountEndpoint } from "./responses.credentials";

test("ChatGPT 계정의 access token과 계정 ID로 여섯 헤더를 만든다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devloop-responses-auth-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const authPath = path.join(directory, "auth.json");
  const ignoredTokenKey = "id" + "_token";
  await writeFile(
    authPath,
    JSON.stringify({ tokens: { access_token: "access-secret", account_id: "account-1", [ignoredTokenKey]: "identity-secret" } }),
  );

  const endpoint = chatgptAccountEndpoint(authPath);
  assert.equal(endpoint.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(Object.keys(endpoint.headers).length, 6);
  assert.equal(endpoint.headers.authorization, "Bearer access-secret");
  assert.equal(endpoint.headers["chatgpt-account-id"], "account-1");
  assert.equal(endpoint.headers["content-type"], "application/json");
  assert.equal(endpoint.headers["openai-beta"], "responses=experimental");
  assert.equal(endpoint.headers.originator, "codex_cli_rs");
  assert.match(endpoint.headers.session_id, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(endpoint), /identity-secret/);
});

test("호출마다 auth 파일과 session ID를 새로 읽는다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devloop-responses-auth-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: "first", account_id: "account-1" } }));
  const first = chatgptAccountEndpoint(authPath);
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: "second", account_id: "account-1" } }));
  const second = chatgptAccountEndpoint(authPath);

  assert.equal(second.headers.authorization, "Bearer second");
  assert.notEqual(first.headers.session_id, second.headers.session_id);
});

test("필수 자격증명이 없으면 토큰 값을 노출하지 않고 실패한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devloop-responses-auth-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const authPath = path.join(directory, "auth.json");
  const secret = "identity-only-secret";
  await writeFile(authPath, JSON.stringify({ tokens: { account_id: "account-1", ["id" + "_token"]: secret } }));

  assert.throws(
    () => chatgptAccountEndpoint(authPath),
    (error: Error) => {
      assert.match(error.message, /access_token/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});
