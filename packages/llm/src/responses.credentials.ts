import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface ResponsesEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
}

interface CodexAuth {
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

/** 호출할 때마다 파일을 다시 읽어 Codex가 갱신한 계정 토큰을 따라간다. */
export function chatgptAccountEndpoint(authPath = resolve(homedir(), ".codex/auth.json")): ResponsesEndpoint {
  let auth: CodexAuth;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuth;
  } catch {
    throw new Error(`Codex 계정 자격증명을 ${authPath}에서 읽지 못했다.`);
  }

  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Codex 계정 자격증명에 access_token이 없다. codex를 한 번 실행해 로그인 정보를 갱신하라.");
  }
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex 계정 자격증명에 account_id가 없다. codex를 한 번 실행해 로그인 정보를 갱신하라.");
  }

  return {
    url: CHATGPT_RESPONSES_URL,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      session_id: randomUUID(),
    },
  };
}
