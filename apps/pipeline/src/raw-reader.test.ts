import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { textContent, textContentPreservingLineBreaks } from "./raw-reader";

const comment = (content: string): Record<string, unknown> => ({ body: { content } });

describe("textContentPreservingLineBreaks", () => {
  it("개행을 남기고 줄 안의 공백만 병합한다", () => {
    const value = comment("첫   줄입니다\n\n둘째\t줄입니다");

    assert.equal(textContentPreservingLineBreaks(value), "첫 줄입니다\n\n둘째 줄입니다");
  });

  it("마크다운 표를 행 단위로 보존한다", () => {
    const table = ["| 레포 | 기존 값 | 변경 값 |", "| --- | --- | --- |", "| cv.ocr.general_inf | 10MB | 30MB |"].join("\n");

    const preserved = textContentPreservingLineBreaks(comment(table));

    assert.equal(preserved, table);
    assert.equal(preserved.split("\n").length, 3);
  });

  it("textContent 는 같은 입력에서 개행을 지운다 — 두 함수의 차이가 이것이다", () => {
    const value = comment("첫 줄\n둘째 줄");

    assert.equal(textContent(value), "첫 줄 둘째 줄");
    assert.equal(textContentPreservingLineBreaks(value), "첫 줄\n둘째 줄");
  });

  it("CRLF 를 LF 로 통일한다", () => {
    assert.equal(textContentPreservingLineBreaks(comment("첫 줄\r\n둘째 줄")), "첫 줄\n둘째 줄");
  });

  it("HTML 태그를 지우고 줄 끝 공백을 남기지 않는다", () => {
    assert.equal(textContentPreservingLineBreaks(comment("<p>본문</p>   \n   다음 줄")), "본문\n다음 줄");
  });

  it("내용이 없으면 빈 문자열이다", () => {
    assert.equal(textContentPreservingLineBreaks({}), "");
    assert.equal(textContentPreservingLineBreaks(undefined), "");
  });
});
