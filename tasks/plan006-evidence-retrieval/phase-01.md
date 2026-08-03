# Phase 01 — 원천 텍스트를 보존하고 훅 머리말을 벗긴다

**Execution profile**: standard
**Status**: pending

---

## 목표

그래프에 저장되는 업무 본문과 댓글이 각각 300자·200자에서 잘린다.
원천 중앙값이 414자와 495자라 댓글의 79%가 잘리고, 평가 세트가 필수 근거로 지목한 댓글 14건은
예외 없이 잘린다. 검색이 닿을 범위와 답변이 인용할 범위가 여기서 막힌다.

저장 상한을 6,000자로 올리고, GitHub 훅 댓글의 링크 머리말만 벗겨 잡음을 없앤다.

설계 근거는 [ADR 0007](../../docs/adr/0007-searchable-source-text.md) 과
`docs/data-schema.md` 의 "본문·댓글 텍스트 보존 규칙" 이다.
문서 계약과 구현이 어긋나면 구현을 임의로 바꾸지 말고 조정자에게 보고한다.

**범위 외**

- 전문 검색 인덱스 추가와 앵커 검색 변경 — Phase 02
- Neo4j 적재와 재측정 — Phase 03
- 평가 세트(`eval/suites/`) 수정 — Phase 04
- 위키 본문 저장 — 평가 세트가 `post`·`comment` 근거만 지원해 효과를 측정할 수 없다

---

## 작업 항목 (4)

### 1. `apps/pipeline/src/parse/parse.const.ts` 를 새로 만든다

저장 상한 두 개를 소유한다. 이 저장소는 상수를 `*.const.ts` 로 분리한다.

```ts
export const TASK_BODY_LIMIT = 6000;
export const COMMENT_EXCERPT_LIMIT = 6000;
```

6,000자는 임의 값이 아니다. 평가 세트의 필수 근거 댓글 14건(길이 470~5,061자)을 전부 담는
최소값이다. 주석으로 그 근거를 남긴다.

### 2. `apps/pipeline/src/parse/github-hook-comment.ts` 를 새로 만든다

훅 댓글 판정과 머리말 제거를 이 모듈이 소유한다.
`structural-extractor.ts` 안에 정규식으로 섞지 않는 이유는 규칙이 좁은지 확인 가능해야 하고,
훅 종류가 늘 때 손댈 자리가 한 곳이어야 하기 때문이다.

```ts
export function isGitHubHookComment(text: string): boolean;
export function stripGitHubHookHeader(text: string): string;
```

훅 머리말은 두 줄 고정 형태다.

```
[[<레포>](<레포 url>)] <사람> pushes [<커밋>](<커밋 url>) to `<브랜치>`
[<제목>](<url>)
```

- `isGitHubHookComment` 는 **첫 줄이 위 첫 줄 형태일 때만** 참이다
- `stripGitHubHookHeader` 는 훅이 아니면 원문을 그대로 돌려준다
- 훅이면 첫 줄과, 이어지는 링크 전용 줄·빈 줄을 벗기고 나머지를 돌려준다
- 벗긴 결과가 비면 원문을 돌려준다

**"앞쪽 링크 줄을 걷어낸다" 는 넓은 규칙을 쓰지 마라.** 사람이 멘션(`[@이름](dooray://...)`)이나
불릿(`*`)으로 시작한 댓글 317건이 함께 깎이는 것을 실측으로 확인했다. 한 건은 304자가 사라진다.

### 3. `structural-extractor.ts` 가 새 모듈과 상수를 쓰게 한다

`taskBodyExcerpt`(`:58-64`)의 `slice(0, 300)` 을 `TASK_BODY_LIMIT` 로 바꾼다.

`addCommentNode`(`:300-310`)의 `commentText.slice(0, 200)` 을
`stripGitHubHookHeader(commentText).slice(0, COMMENT_EXCERPT_LIMIT)` 로 바꾼다.

**머리말 벗기기를 `addCommentNode` 밖으로 올리지 마라.** 바로 위 `:296` 의
`addTextReferences(project, commentText, ...)` 가 같은 문자열로 업무 참조를 뽑는다.
가공한 값을 넘기면 `REFERENCES` 328건이 조용히 바뀐다. 어렵게 오탐을 정리한 값이다.

### 4. 잘린 건수를 요약에 출력한다

상한을 넘겨 잘린 업무 본문과 댓글의 건수를 `parse-structure` 요약에 넣는다.
조용한 손실을 막는 것이 목적이다. 기존 요약 출력 형식을 따르고 새 형식을 만들지 마라.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/parse/parse.const.ts` | 신규 |
| `apps/pipeline/src/parse/github-hook-comment.ts` | 신규 |
| `apps/pipeline/src/parse/github-hook-comment.test.ts` | 신규 |
| `apps/pipeline/src/parse/structural-extractor.ts` | 수정 |
| `apps/pipeline/package.json` | 수정 — test glob |

## 검증

**테스트 glob 을 반드시 갱신하라.** `apps/pipeline/package.json` 의 `test` 스크립트가
경로를 열거하는 방식이라 `dist/parse/*.test.js` 가 목록에 **없다.**
추가하지 않으면 새 테스트가 실행되지 않고 초록으로 보인다.

새 테스트가 덮어야 할 것이다.

- 훅 댓글에서 머리말 두 줄이 사라지고 커밋 메시지가 남는다
- 멘션으로 시작하는 사람 댓글이 **한 글자도** 바뀌지 않는다
- 불릿으로 시작하는 사람 댓글이 바뀌지 않는다
- 훅 머리말만 있고 본문이 없으면 원문을 유지한다
- 상한 경계 — 6,000자 이하는 온전히, 초과는 6,000자로 잘린다

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter pipeline test
pnpm format:check
```

`pnpm --filter pipeline test` 의 **테스트 개수가 140 에서 늘어야 한다.** 통과 표시가 아니라 개수를 본다.

실제 데이터로 확인한다.

```bash
# cwd: 저장소 루트
pnpm --filter pipeline parse-structure --project tc-ocr
```

산출된 `apps/pipeline/data/graph/tc-ocr/parsed.jsonl` 에서 아래를 확인한다.

- `Comment` 노드 수가 854 로 불변이다 (댓글을 버리지 않는다)
- `REFERENCES` 관계 수가 328 로 불변이다
- `excerpt` 가 200자를 넘는 노드가 나타난다
- 훅 댓글의 `excerpt` 가 `[[` 로 시작하지 않는다

**변이 검증** — `stripGitHubHookHeader` 의 훅 판정을 무력화해 항상 참을 돌려주게 만들고,
사람 댓글 보존 테스트가 실제로 실패하는지 확인한 뒤 원복한다.
테스트가 있다는 것과 그 테스트가 무언가를 보호한다는 것은 다르다.

## 의도 메모 (왜)

- **상한을 6,000자로 정한 이유** — 필수 근거를 전부 덮는 최소값이다. 2,000자면 10/14, 5,000자면 13/14 다.
  크게 잡을수록 답변 합성 프롬프트가 커지므로 여유로 올리지 않는다
- **훅 댓글을 버리지 않는 이유** — 359건 전부 커밋 메시지를 담고 있고 평가 세트의 필수 근거 2건이 그중이다.
  버리면 그 문항이 영구히 답할 수 없게 된다
- **판정 규칙을 전용 모듈로 뺀 이유** — 넓은 규칙이 사람 댓글 317건을 깎을 뻔했다.
  규칙 단위로 테스트를 붙일 대상이 있어야 오탐이 드러난다
- 이 phase 가 Phase 02 의 전제다. 검색 인덱스를 걸어도 색인할 텍스트가 200자면 같은 맹점이 남는다
