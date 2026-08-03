/**
 * 목록에 보여 줄 `Comment` 표시 문자열의 상한이다.
 *
 * 저장 상한이 6,000자로 올라갔으므로 표시용은 따로 자른다. 근거 노드의 `excerpt` 속성은
 * 그대로 길어야 답변이 인용할 수 있어, 자르는 대상은 `display` 뿐이다.
 */
export const COMMENT_DISPLAY_LIMIT = 120;
