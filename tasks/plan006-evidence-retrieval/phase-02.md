# Phase 02 — 본문·댓글 전문 검색 인덱스와 댓글 히트 승격을 넣는다

**Execution profile**: standard
**Status**: completed

---

## 목표

전문 검색이 제목과 이름만 덮는다. 업무 본문과 댓글에는 인덱스가 없어 검색 경로가 아예 없다.

실측 사례다. 어떤 질문이 "모델서버 쪽에서 먼저 발견한 병목" 을 묻는데, 정답 댓글 본문에
"모델 서버 envoy 버퍼 한도 병목" 이라고 그대로 적혀 있다. 그런데 그 업무의 제목은
"요청 크기 제한 상향 — multipart, WebClient" 라 질문의 단어가 하나도 없다.
검색이 제목만 보므로 정답 업무에 닿을 길이 없고, 엔진은 엉뚱한 업무 4건을 앵커로 잡아
확신 있게 틀린 답을 냈다.

본문과 댓글을 검색 대상에 넣고, 검색이 댓글을 찾으면 그 부모 업무를 앵커로 올린다.

설계 근거는 [ADR 0007](../../docs/adr/0007-searchable-source-text.md) 과
`docs/flow.md` 의 질의응답 흐름이다.

**이 phase 는 Phase 01 이 만드는 6,000자 텍스트를 전제한다.**
`apps/pipeline/src/parse/parse.const.ts` 가 없으면 base 를 확인하고 멈춘다.

**범위 외**

- 파이프라인 텍스트 보존 — Phase 01
- Neo4j 적재와 재측정 — Phase 03
- 평가 세트 수정 — Phase 04
- 벡터 유사도 검색 — ADR 0007 이 기각 사유와 선행 조건을 기록했다
- Cypher 생성 프롬프트 변경 — 아래 승격 방식을 택한 이유가 프롬프트를 안 건드리는 것이다

---

## 작업 항목 (4)

### 1. `apps/pipeline/src/neo4j/schema.cy` 에 인덱스 두 개를 더한다

기존 세 줄(`:9-11`)과 같은 형식으로 이어서 쓴다. analyzer 는 반드시 `cjk` 다.

```cypher
CREATE FULLTEXT INDEX task_body_fulltext IF NOT EXISTS FOR (n:Task) ON EACH [n.bodyExcerpt] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } };
CREATE FULLTEXT INDEX comment_excerpt_fulltext IF NOT EXISTS FOR (n:Comment) ON EACH [n.excerpt] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } };
```

`cjk` 는 한국어를 두 글자씩 겹쳐 쪼갠다. 그래서 `요청크기` 와 `요청 크기` 가 같은 노드를
같은 점수로 찾는다. 실측으로 확인했으므로 다른 analyzer 를 검토하지 마라.

### 2. `apps/api/src/query/query.const.ts` 의 검색 대상을 넓힌다

`FULLTEXT_INDEXES` 에 새 인덱스 두 개를 더한다. 배열 순서는 기존 셋 뒤에 붙인다.

`ANCHOR_CANDIDATE_LIMIT`·`ANCHOR_LABEL_QUOTAS`·`EVIDENCE_NODE_LIMIT` 은 **바꾸지 마라.**
아래 승격 방식은 앵커 목록에 `Comment` 를 남기지 않으므로 라벨 정원을 건드릴 이유가 없다.
상한을 함께 바꾸면 Phase 03 에서 회수 실패가 줄었을 때 원인을 가를 수 없다.

### 3. `query.service.ts` 에 댓글 히트 승격을 넣는다

```ts
private async promoteCommentHits(matches: FulltextMatch[]): Promise<FulltextMatch[]>;
```

`fulltextSearch` 결과에 `Comment` 노드가 있으면 `(c:Comment)<-[:HAS_COMMENT]-(t:Task)` 로
부모 업무를 찾아 **그 업무로 바꿔 넣는다.** 규칙이다.

- 댓글이 갖고 있던 **순위와 점수를 부모가 물려받는다.** `rankAnchorCandidates` 가 순위 역수로
  융합하므로(`:359`), 댓글이 1위였으면 그 업무가 1위로 들어가야 융합에서 제 무게를 갖는다
- 같은 업무의 댓글이 여러 건 걸리면 **가장 높은 순위 하나로 합친다**
- 승격한 업무가 이미 결과에 있으면 더 높은 순위를 남긴다
- 부모를 못 찾으면 그 히트를 버린다. 앵커 목록에 `Comment` 를 남기지 않는다

`query` 메서드(`:42`)에서 `fulltextSearch` 결과를 `rankAnchorCandidates` 에 넘기기 전에 끼운다.
부모 조회는 검색어 개수만큼 반복하지 말고 **한 번에 모아 조회**한다.

### 4. `neo4j.service.ts` 의 `Comment` 표시 문자열을 짧게 자른다

`displayFor`(`:144-153`)가 `Comment` 에 `excerpt` 전체를 쓴다. 상한이 6,000자로 올라가면
목록에 6,000자짜리 문자열이 들어간다.

`Comment` 의 `display` 를 짧게(120자 안팎) 자른다. 다른 라벨은 건드리지 마라.

저장한 본문은 길게 두고 목록 표시만 짧게 하는 것이다. 근거 노드의 `excerpt` 속성은 그대로 길어야
답변이 인용할 수 있다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/neo4j/schema.cy` | 수정 |
| `apps/api/src/query/query.const.ts` | 수정 |
| `apps/api/src/query/query.service.ts` | 수정 |
| `apps/api/src/neo4j/neo4j.service.ts` | 수정 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

`test:unit` 을 쓴다. `pnpm --filter api test` 는 스크립트가 없어 **exit 0 으로 조용히 통과**한다.
테스트 개수가 51 에서 늘어야 한다.

새 테스트가 덮어야 할 것이다.

- 댓글 히트가 부모 업무로 바뀌고 순위를 물려받는다
- 같은 업무의 댓글 두 건이 하나로 합쳐진다
- 부모를 못 찾은 댓글 히트가 결과에서 사라진다
- 승격 결과에 `Comment` 라벨이 남지 않는다
- `displayFor` 가 긴 `Comment` 를 자르고 다른 라벨은 그대로 둔다

**변이 검증** — 순위 승계를 무력화해 항상 최하위로 넣게 만들고 승계 테스트가 실제로 실패하는지
확인한 뒤 원복한다.

## 의도 메모 (왜)

- **댓글을 앵커 목록에 그대로 넣지 않는 이유** — 그러면 Cypher 생성 프롬프트가 새 라벨을 다루는
  법을 알아야 하고 앵커 슬롯 8개를 댓글이 잠식한다. 무엇보다 프롬프트까지 함께 바뀌면
  Phase 03 에서 회수 실패가 줄었을 때 텍스트 확보 덕인지 프롬프트 덕인지 가를 수 없다
- 승격으로 부족한 문항이 남으면 그때 실측 근거를 갖고 댓글 앵커를 더한다
- **상한 상수를 안 건드리는 이유도 같다.** 한 번에 여러 지레를 당기면 무엇이 들었는지 모른다
- `/api/graph/search` 가 같은 검색 함수를 쓰므로 웹 인스턴스 탐색 결과에도 댓글이 섞인다.
  의도된 변화이고, 그래서 표시 문자열을 자른다
