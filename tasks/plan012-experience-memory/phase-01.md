# Phase 01 — 세 원천을 안정적인 evidence packet으로 정규화한다

**Execution profile**: standard
**Status**: pending

---

## 목표

Dooray 업무·댓글·Wiki와 `/Users/nhn/projects/OCR` 아래 Git 저장소를 읽기 전용으로 정규화한다.
같은 snapshot에서는 byte가 같은 source generation을 만들고 모든 segment에 안정 ID와 실제 원문 URL을 연결한다.

설계 계약은 `docs/data-schema.md`, 흐름은 `docs/flow.md`, 모듈 배치는 `docs/code-architecture.md`, 장기 결정은 ADR 0010과 ADR 0011을 따른다.

**범위 외**

- LLM 호출과 Memory 추출 — Phase 02
- Markdown 생성과 검색 — Phase 03
- source checkout, fetch, reset, clean 또는 Dooray 쓰기
- `docs/memory/` 같은 별도 관리 문서군과 새 package, DB, service

---

## 작업 항목 (5)

### 1. 공유 Memory 계약을 정의한다

`packages/shared/src/memory/memory.const.ts`와 `memory.schema.ts`를 만들고 `packages/shared/src/index.ts`에서 export한다.

- `SourceRef`: `sourceType`, `sourceId`, `url`, `title`, 선택 `repository`, `revision`, `path`, `parentId`, `occurredAt`
- `EvidencePacket`: `schemaVersion`, `id`, `project`, `sourceKind`, `title`, `scope`, `segments`, `sourceRefs`, `contentHash`
- `MemoryRecord`: `kind`, `status`, `confidence`, `summary`, `why`, `doNot`, `scope`, 유효 기간, 검색어, `sourceRefs`
- enum 값과 필수 조건은 `docs/data-schema.md`와 정확히 맞춘다.
- `contentHash`와 Memory ID를 위한 canonical JSON은 object key를 정렬하고 array 순서는 의미가 있는 곳에서 보존한다.
- segment가 SourceRef를 가리키는 합성 키는 `sourceType:sourceId` 형식의 `sourceRefKey(ref)` 하나로 만든다.

### 2. Dooray raw를 evidence로 바꾼다

`apps/pipeline/src/memory/dooray-source.ts`에서 기존 `readRawProject`, `firstString`, `textContentPreservingLineBreaks`를 재사용한다.

- 업무 source ID는 raw `post.id`, 표시 번호는 `post.number`다. URL은 `https://nhnent.dooray.com/project/tasks/{post.id}`다.
- 댓글 source ID는 `comment.id`, `parentId`는 `post.id`, URL은 부모 업무 URL이다. 본문과 댓글은 서로 다른 segment와 SourceRef로 둔다.
- Wiki source ID는 `pageId` 또는 `id`, URL은 `https://nhnent.dooray.com/project/pages/{pageId}`다.
- 필수 ID나 본문이 없으면 조용히 만들지 말고 원천 종류와 위치가 포함된 오류로 실패한다.

### 3. OCR Git 저장소를 읽기 전용으로 정규화한다

`apps/pipeline/src/memory/git-source.ts`에서 Git 명령을 argument array로 실행한다.

- git root의 직계 하위 저장소를 이름순으로 찾고 `origin/HEAD^{commit}`을 고정한다. 없으면 해당 저장소 오류로 전체 정규화를 실패시킨다.
- remote URL은 `git remote get-url origin`으로 읽어 HTTP 원문 URL의 base로 정규화한다.
- Git local path는 manifest에 저장하지 않는다. commit source ID는 `<repository>@<revision>`, file source ID는 `<repository>@<revision>:<path>`다.
- 기본 branch의 non-merge commit message, changed path, 문자 상한이 있는 diff hunk를 가져온다. binary와 생성 파일은 제외한다.
- 현재 경험 문서는 root의 `README.md`, `CLAUDE.md`, `AGENTS.md`와 `docs/**/*.md`만 pinned revision에서 읽는다.
- commit URL은 `/commit/{40자 SHA}`, 파일 URL은 `/blob/{40자 SHA}/{path}`다. working tree 파일을 직접 읽지 않는다.

### 4. manifest와 evidence를 immutable generation으로 쓴다

`apps/pipeline/src/memory/evidence-normalizer.ts`가 두 source adapter를 합치고 `apps/pipeline/data/memory/<project>/`에 쓴다.

- manifest에는 Dooray canonical content hash·건수와 Git 저장소별 remote URL·revision을 기록한다. local path와 존재하지 않는 수집 시각을 넣지 않는다.
- 정렬 기준을 고정한 뒤 canonical JSON의 SHA-256으로 `contentHash`를 만든다.
- `source-generations/<sourceGenerationId>/`의 manifest와 evidence를 임시 디렉터리에 모두 쓴 뒤 rename한다.
- 두 파일을 검증한 다음 `current-source.json` pointer만 원자적으로 교체한다. 실패 시 이전 pointer와 generation을 유지한다.
- `apps/pipeline/data/memory/`는 기존 `apps/pipeline/data/*` ignore 규칙 안에 있어야 하며 예외로 추적하지 않는다.

### 5. normalize 명령과 단위 테스트를 추가한다

`apps/pipeline/src/memory/cli.ts`에 `normalize --project <name> --git-root <path> [--data-dir <path>]`를 만들고 package script `normalize-memory`를 추가한다.
pipeline test script에 `dist/memory/*.test.js`를 명시해 새 테스트가 실제로 실행되게 한다.

fixture Git 저장소와 임시 Dooray raw로 다음을 검증한다.

- 실제 Dooray URL 세 종류와 comment의 부모 link
- pinned revision의 commit·file URL과 working tree 변경 무시
- checkout/fetch/reset/clean을 호출하지 않음
- 입력 순서가 달라도 같은 JSONL·hash
- 저장소 하나 실패 시 기존 정상 generation과 pointer 보존

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `packages/shared/src/memory/memory.const.ts` | 신규 — enum과 파일 계약 상수 |
| `packages/shared/src/memory/memory.schema.ts` | 신규 — SourceRef, EvidencePacket, MemoryRecord |
| `packages/shared/src/index.ts` | 수정 — Memory 계약 export |
| `apps/pipeline/src/memory/dooray-source.ts` | 신규 — Dooray evidence |
| `apps/pipeline/src/memory/git-source.ts` | 신규 — pinned Git evidence |
| `apps/pipeline/src/memory/evidence-normalizer.ts` | 신규 — manifest, hash, atomic write |
| `apps/pipeline/src/memory/cli.ts` | 신규 — normalize 진입점 |
| `apps/pipeline/package.json` | 수정 — `normalize-memory` script |
| `apps/pipeline/src/memory/*.test.ts` | 신규 — 실제 형태 fixture 회귀 테스트 |

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter @devloop/shared build
pnpm --filter pipeline test
pnpm format:check
git diff --check
```

테스트의 임시 Git 저장소에 uncommitted 변경을 만든 뒤, evidence가 pinned commit 내용만 포함하는지 assert한다.
Dooray task·comment·Wiki와 Git commit·file SourceRef 각각에 HTTP URL이 있고 URL 안의 ID 또는 SHA가 SourceRef와 같은지 assert한다.

## 의도 메모 (왜)

- 안정 ID와 URL을 함께 두면 원천 이동에 견디면서 사람이 바로 검증할 수 있다.
- Git object를 읽으면 사용자가 작업 중인 9개 저장소의 branch와 파일을 건드리지 않는다.
- 정규화를 LLM 단계와 분리해야 원천 오류를 token 사용 전에 발견한다.

## Blocked 조건

GitHub Issue 세트가 아직 등록되지 않았다면 production code를 수정하지 말고 `PHASE_BLOCKED: GitHub Issue 사전 등록 필요`를 출력한다.
