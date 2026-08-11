# Phase 03 — compact Wiki와 단일 lexical 검색을 구현한다

**Execution profile**: standard
**Status**: completed

---

## 목표

검증된 MemoryRecord를 짧은 Markdown과 JSON index로 결정적으로 만들고, Coding Agent가 한 번 호출하는 `memory-search` JSON 인터페이스를 제공한다.
검색 경로는 LLM, Neo4j, Postgres와 새 dependency를 사용하지 않는다.

**범위 외**

- vector DB, embedding, SQLite FTS
- HTTP endpoint, MCP server, 신규 UI
- query expansion LLM과 자동 retrieval
- GraphRAG 삭제 또는 API 변경

---

## 작업 항목 (4)

### 1. compact Wiki builder를 만든다

`apps/pipeline/src/memory/wiki-builder.ts`가 `current-extraction.json`의 deterministic manifest와 JSONL을 Zod로 읽어
`wiki-generations/<wikiGenerationId>/` 아래 kind별 디렉터리와 `index.md`, `index.json`을 생성한다.

- Markdown에는 title, status, confidence, scope, summary, why, 선택 doNot, 모든 SourceRef 링크만 쓴다.
- slug 충돌은 Memory ID suffix로 해결하고 파일명과 정렬을 결정적으로 만든다.
- `index.json`에는 Markdown을 다시 parse하지 않고 검색할 정규화 필드와 원본 MemoryRecord를 둔다.
- source manifest hash와 `complete`를 전달한다. incomplete 입력은 명시 옵션 없이는 build를 거부한다.
- lock과 임시 generation rename 후 `current-wiki.json` pointer를 원자적으로 교체해 이전 정상 Wiki를 보존한다.

### 2. Node 표준 라이브러리 lexical ranking을 만든다

`apps/pipeline/src/memory/lexical-search.ts`에서 query를 lowercase·Unicode normalize하고 공백·문장부호 token으로 나눈다.
title, relatedTerms, summary, why, scope를 서로 다른 고정 weight로 점수화한다.

동점은 confidence, status 우선순위, Memory ID로 정렬한다.
`superseded`, `deprecated`, `historical`, `uncertain`을 숨기지 않고 status 경고와 감점으로 반환한다.
project·repository·module·path scope filter와 top-k 상한을 제공한다.

### 3. 단일 검색 명령을 완성한다

`memory/cli.ts`에 `build`와 `search`를 추가하고 package scripts `build-memory-wiki`, `memory-search`를 만든다.

`memory-search --query <text> [--project <name>] [--repository <name>] [--path <path>] [--top-k <n>] [--data-dir <path>] [--allow-incomplete]`는 stdout에 JSON 하나만 쓴다.
응답에는 `results`, 각 result의 `id`, `title`, `kind`, `status`, `confidence`, `summary`, `score`, `matchedTerms`, 전체 `sourceRefs`와 `searchMs`, `documentsScanned`, `returned`를 포함한다.
정상 0건은 exit 0과 `results: []`다. incomplete index는 `--allow-incomplete` 없이는 실패한다.

### 4. builder와 검색 회귀 테스트를 붙인다

다음을 fixture index로 검증한다.

- 같은 extracted 입력의 Markdown·index byte 동일
- 모든 Markdown과 검색 result에서 원문 URL 보존
- title/relatedTerms 일치가 본문 약한 일치보다 높은 순위
- scope filter, status 감점, confidence와 ID tie-break
- 0건 정상 응답, incomplete 기본 거부
- 검색 중 LLM/Neo4j/Postgres import와 호출 없음
- Memory title의 개행 schema 위반 거부

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/memory/wiki-builder.ts` | 신규 — Markdown과 JSON index |
| `apps/pipeline/src/memory/lexical-search.ts` | 신규 — tokenization, ranking, scope filter |
| `apps/pipeline/src/memory/cli.ts` | 수정 — build와 search 진입점 |
| `apps/pipeline/package.json` | 수정 — build/search scripts |
| `apps/pipeline/src/memory/wiki-builder.test.ts` | 신규 — 결정성과 link 검증 |
| `apps/pipeline/src/memory/lexical-search.test.ts` | 신규 — ranking과 empty/incomplete 검증 |

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter pipeline test
pnpm -r build
pnpm format:check
git diff --check
```

두 번 build한 `wiki/` tree의 file hash 목록이 같은지 테스트한다.
검색 모듈 dependency graph에서 `llm`, `neo4j-driver`, `pg` import가 0건인지 확인한다.

## 의도 메모 (왜)

- JSON index를 실행 계약으로 두면 Markdown 표현 변경이 검색 동작을 조용히 바꾸지 않는다.
- lexical 기준선은 Retrieval Tax가 가장 작은 비교점이고 의미 검색 도입 여부를 실측하게 한다.
- 한 JSON 응답에 근거 link까지 담아 Agent의 후속 탐색 호출을 줄인다.
