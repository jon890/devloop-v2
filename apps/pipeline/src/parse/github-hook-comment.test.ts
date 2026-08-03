import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGitHubHookComment, stripGitHubHookHeader } from "./github-hook-comment";
import { COMMENT_EXCERPT_LIMIT } from "./parse.const";

const REPO = "[[TOASTCloud/OCR.Console](https://github.nhnent.com/TOASTCloud/OCR.Console)]";
const COMMIT = "[62d7fab](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/62d7fab340f5)";
const HOOK_FIRST_LINE = `${REPO} eundong-lee pushes ${COMMIT} to \`refs/heads/develop\``;
const HOOK_TITLE_LINE = "[Push Default Branch `refs/heads/develop`](https://github.nhnent.com/TOASTCloud/OCR.Console/tree/develop)";

describe("stripGitHubHookHeader", () => {
  it("훅 댓글에서 머리말 두 줄이 사라지고 커밋 메시지가 남는다", () => {
    const text = `${HOOK_FIRST_LINE}\n${HOOK_TITLE_LINE}\ntc-ocr/100 특정 URI의 요청을 Audit log에서 제외한다\n\nMerge pull request #45`;

    const stripped = stripGitHubHookHeader(text);

    assert.equal(isGitHubHookComment(text), true);
    assert.equal(stripped, "tc-ocr/100 특정 URI의 요청을 Audit log에서 제외한다\n\nMerge pull request #45");
    assert.ok(!stripped.startsWith("[["), "머리말을 벗긴 결과는 [[ 로 시작하지 않는다");
  });

  // 실측 훅 359건 중 3건이 단수형 `push` 다 (`18.json` 2건, `25.json` 1건). 사람 이름만 가명으로
  // 바꾸고 형태는 원천 그대로 두어 회귀로 고정한다. `pushes?` 로 쓰면 이 3건이 빠진다.
  const SINGULAR_HOOKS = [
    {
      name: "18.json — Merge pull request",
      text: `${REPO} first-dev push [a3f5648](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/a3f5648) to \`refs/heads/develop\`\n[Merge pull request #1 from TOASTCloud/tc-ocr/18](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/a3f5648)\ntc-ocr/18 템플릿 내의 예제 코드 삭제`,
      body: "tc-ocr/18 템플릿 내의 예제 코드 삭제",
    },
    {
      name: "18.json — Revert, 브랜치명에 슬래시가 있다",
      text: `${REPO} first-dev push [e1331eb](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/e1331eb) to \`refs/heads/revert-1-tc-ocr/18\`\n[Revert "#tc-ocr/18 이미지 업로드 및 미리보기 프론트엔드 구현"](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/e1331eb)\nRevert "#tc-ocr/18 이미지 업로드 및 미리보기 프론트엔드 구현"`,
      body: 'Revert "#tc-ocr/18 이미지 업로드 및 미리보기 프론트엔드 구현"',
    },
    {
      name: "25.json — Merge pull request",
      text: `${REPO} second-dev push [af0dbd1](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/af0dbd1) to \`refs/heads/develop\`\n[Merge pull request #3 from TOASTCloud/tc-ocr/25](https://github.nhnent.com/TOASTCloud/OCR.Console/commit/af0dbd1)\ndocument ocr 상품 eanble/disable API`,
      body: "document ocr 상품 eanble/disable API",
    },
  ];

  for (const hook of SINGULAR_HOOKS) {
    it(`단수형 push 훅도 머리말을 벗긴다 — ${hook.name}`, () => {
      assert.equal(isGitHubHookComment(hook.text), true);
      assert.equal(stripGitHubHookHeader(hook.text), hook.body);
    });
  }

  it("멘션으로 시작하는 사람 댓글이 한 글자도 바뀌지 않는다", () => {
    const text = "[@홍길동](dooray://3570973280734982045/members/1234567890)\n확인했습니다. 요청 크기 상향은 별도 업무로 분리합니다.";

    assert.equal(isGitHubHookComment(text), false);
    assert.equal(stripGitHubHookHeader(text), text);
  });

  it("불릿으로 시작하는 사람 댓글이 바뀌지 않는다", () => {
    const text = "* 모델 서버 envoy 버퍼 한도가 병목이다\n* multipart 요청 크기 제한을 올린다";

    assert.equal(isGitHubHookComment(text), false);
    assert.equal(stripGitHubHookHeader(text), text);
  });

  it("링크 한 줄로 시작하는 사람 댓글이 바뀌지 않는다", () => {
    const text = "[관련 위키](https://nhnent.dooray.com/wiki/1)\n여기 정리해 두었습니다.";

    assert.equal(isGitHubHookComment(text), false);
    assert.equal(stripGitHubHookHeader(text), text);
  });

  it("훅 머리말만 있고 본문이 없으면 원문을 유지한다", () => {
    const text = `${HOOK_FIRST_LINE}\n${HOOK_TITLE_LINE}\n`;

    assert.equal(isGitHubHookComment(text), true);
    assert.equal(stripGitHubHookHeader(text), text);
  });

  it("훅 첫 줄 형태가 아니면 뒤에 훅 문구가 있어도 판정하지 않는다", () => {
    const text = `아래는 훅이 남긴 내용입니다.\n${HOOK_FIRST_LINE}`;

    assert.equal(isGitHubHookComment(text), false);
    assert.equal(stripGitHubHookHeader(text), text);
  });
});

// 이 규칙은 개행이 살아 있는 텍스트를 전제한다. 개행이 공백으로 병합된 값을 넘기면 훅을 한 건도
// 잡지 못하므로, 호출부가 textContentPreservingLineBreaks 를 쓴다는 전제를 여기서 고정한다.
describe("stripGitHubHookHeader — 개행 전제", () => {
  it("개행이 공백으로 병합되면 훅을 잡지 못한다", () => {
    const collapsed = `${HOOK_FIRST_LINE}\n${HOOK_TITLE_LINE}\ntc-ocr/100 Audit log 제외 처리`.replace(/\s+/g, " ").trim();

    assert.equal(isGitHubHookComment(collapsed), false, "개행 없는 값은 이 규칙의 입력이 아니다");
  });

  it("마크다운 표가 든 훅 댓글에서 표의 행 경계가 살아남는다", () => {
    const table = ["| 레포 | 기존 값 | 변경 값 |", "| --- | --- | --- |", "| cv.ocr.general_inf | 10MB | 30MB |"].join("\n");
    const text = `${HOOK_FIRST_LINE}\n${HOOK_TITLE_LINE}\n${table}`;

    const stripped = stripGitHubHookHeader(text);

    assert.equal(stripped, table);
    assert.equal(stripped.split("\n").length, 3, "표가 3행으로 남는다");
  });
});

describe("댓글 excerpt 상한 경계", () => {
  const excerpt = (text: string): string => stripGitHubHookHeader(text).slice(0, COMMENT_EXCERPT_LIMIT);

  it("상한 이하는 온전히 보존된다", () => {
    const text = "가".repeat(COMMENT_EXCERPT_LIMIT);

    assert.equal(excerpt(text).length, COMMENT_EXCERPT_LIMIT);
    assert.equal(excerpt(text), text);
  });

  it("상한을 넘기면 상한까지만 남는다", () => {
    const text = "가".repeat(COMMENT_EXCERPT_LIMIT + 500);

    assert.equal(excerpt(text).length, COMMENT_EXCERPT_LIMIT);
  });

  it("기존 상한 200자를 넘는 댓글이 이제 살아남는다", () => {
    const text = "나".repeat(1500);

    assert.equal(excerpt(text).length, 1500);
  });
});
