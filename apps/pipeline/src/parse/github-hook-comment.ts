/**
 * GitHub 훅이 Dooray 댓글로 남기는 링크 머리말을 판정하고 벗긴다.
 *
 * 훅 머리말은 두 줄 고정 형태다.
 *
 * ```
 * [[<레포>](<레포 url>)] <사람> push(es) [<커밋>](<커밋 url>) to `<브랜치>`
 * [<제목>](<url>)
 * ```
 *
 * 이 모듈은 **개행이 살아 있는 텍스트**를 전제한다. 호출부가
 * `textContentPreservingLineBreaks` 값을 넘기는 이유가 이것이다 — 개행을 공백으로 병합하는
 * `textContent` 값을 넘기면 훅 359건이 한 건도 매칭되지 않는다 (실측).
 *
 * 판정을 `structural-extractor` 안에 정규식으로 섞지 않고 전용 모듈로 둔 이유는,
 * 규칙이 좁은지 테스트로 확인할 대상이 있어야 하고 훅 종류가 늘 때 손댈 자리가 한 곳이어야 하기
 * 때문이다. "앞쪽 링크 줄을 걷어낸다" 는 넓은 규칙을 쓰면 사람 댓글이 함께 깎인다 —
 * 실측하면 첫 줄이 링크나 불릿으로 시작하는 사람 댓글이 336건이고 그중 40건의 내용이
 * 실제로 줄어든다 (최대 699자 손실). 지금 규칙은 사람 댓글 495건을 한 건도 바꾸지 않는다.
 */

/**
 * 훅 머리말 첫 줄 전체를 요구한다. 레포 링크·사람·커밋 링크·백틱 브랜치가 모두 있어야 참이다.
 * 동사만 보고 판정하지 않는다.
 *
 * `push(?:es)?` 로 단수형까지 받는다 — 실측 훅 359건 중 3건이 `push` 다 (`18.json` 2건, `25.json` 1건).
 * `pushes?` 로 쓰지 마라. 그것은 `pushe` 뒤의 `s` 가 선택이라는 뜻이라 정작 `push` 를 놓친다
 * (실측: 359건 중 356건만 잡는다).
 */
const GITHUB_HOOK_HEADER_LINE = /^\[\[[^\]]+\]\([^)]+\)\]\s+\S.*?\s+push(?:es)?\s+\[[^\]]+\]\([^)]+\)\s+to\s+`[^`]+`\s*$/;

/** 머리말 둘째 줄처럼 링크 하나만 있는 줄이다. */
const LINK_ONLY_LINE = /^\[[^\]]*\]\([^)]+\)\s*$/;

export function isGitHubHookComment(text: string): boolean {
  return GITHUB_HOOK_HEADER_LINE.test(text.split("\n", 1)[0] ?? "");
}

export function stripGitHubHookHeader(text: string): string {
  if (!isGitHubHookComment(text)) return text;
  const lines = text.split("\n");
  let index = 1;
  while (index < lines.length && (LINK_ONLY_LINE.test(lines[index]) || lines[index].trim() === "")) index += 1;
  const stripped = lines.slice(index).join("\n").trim();
  // 머리말만 있고 커밋 메시지가 없는 댓글은 원문을 남긴다. 빈 excerpt 보다 낫다.
  return stripped.length > 0 ? stripped : text;
}
