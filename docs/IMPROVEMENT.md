# devloop-v2 — Coding Agent Experience Memory 재설계, GitHub Issues 도출 및 구현

## 역할

당신은 이 저장소의 아키텍처를 검토하는 Staff+ 수준의 소프트웨어 엔지니어이자 AI Agent Memory 시스템 설계자다.

대상 저장소:

[`https://github.com/jon890/devloop-v2`](https://github.com/jon890/devloop-v2)

먼저 현재 시스템이 해결하려는 문제와 기존 구현을 충분히 조사한 뒤, 새로운 방향의 타당성을 검증하고 실제 구현 작업을 GitHub Issues로 분해하는 것이 목적이다.

Issue를 만들기 전에는 production code를 구현하지 않는다.

Issue 분해와 사전 검토가 끝나면 실증으로 선택한 최소 아키텍처를 구현하고 검증한다.

최종 산출물은 **설계 문서, 실행 가능한 GitHub Issues 세트, 검증된 Experience Memory 구현**이다.

---

# 1. 문제 제기

현재 devloop-v2는 Dooray 업무와 Wiki에서 지식을 추출해 Neo4j 기반 Knowledge Graph를 구축하고 GraphRAG 방식으로 질의하는 구조다.

현재 시스템의 핵심 문제의식은 다음과 같다.

- 과거에 왜 특정 결정을 했는가?
- 특정 장애와 어떤 업무가 연결되어 있는가?
- 어떤 개념과 관련된 문서가 어디에 있는가?
- 코드만 읽어서는 알 수 없는 과거 맥락은 무엇인가?

현재 접근은 이를 해결하기 위해 다음과 같은 방향을 선택했다.

- Dooray 업무 / Wiki 수집
- 구조 정보 parsing
- LLM 기반 Concept / Decision 추출
- 고정 ontology
- Neo4j graph
- GraphRAG
- 자연어 → anchor → Cypher → subgraph → answer

하지만 이 프로젝트의 활용 목적을 **범용 지식그래프 탐색 도구가 아니라 Claude Code / Codex 같은 Coding Agent의 장기 업무 Memory**로 바꿔 생각하면 몇 가지 의문이 생긴다.

---

# 2. 핵심 가설

다음 가설들을 비판적으로 검토하라.

## 가설 A — Coding Agent에게 Graph 자체가 필요한가?

Claude Code나 Codex는 이미 코드베이스를 직접 탐색하는 능력이 매우 강하다.

예:

- 파일 검색
- grep
- symbol 탐색
- git history
- 테스트
- source reading
- dependency 추론

따라서 다음과 같은 정보는 별도 Memory에 저장하는 가치가 낮을 수 있다.

- 현재 class hierarchy
- 함수 위치
- caller / callee
- 현재 코드 dependency
- 코드에서 다시 확인 가능한 implementation fact

이런 정보까지 Graph Memory로 만들어 Agent에게 graph traversal tool을 제공하면 오히려 다음 비용이 발생할 수 있다.

- tool call 증가
- agent loop 증가
- latency 증가
- context 증가
- 오래된 graph와 현재 코드의 불일치
- Agent가 source와 memory를 중복 탐색

**검토 질문**

> Coding Agent가 source에서 쉽게 재구성할 수 있는 정보를 굳이 장기 Memory로 유지해야 하는가?

---

## 가설 B — 진짜 가치 있는 Memory는 Experience Memory다

Coding Agent가 현재 repository를 아무리 잘 읽더라도 다음 정보는 알아낼 수 없다.

예:

- 왜 이렇게 설계했는가
- 어떤 대안을 시도했다가 실패했는가
- 어떤 운영 장애 때문에 현재 제약이 생겼는가
- 과거 논의에서 무엇을 선택했고 무엇을 포기했는가
- 코드에는 드러나지 않는 운영상 제약
- 특정 설정값이 그렇게 정해진 이유
- 특정 모듈을 수정하면 안 되는 조직적 / 역사적 이유
- 이전 migration에서 발생했던 문제
- 실험 결과와 당시 판단
- 아직 유효한 의사결정
- superseded된 과거 결정

즉 Memory의 핵심 가치는

`Code Knowledge`

보다

`Experience / Decision Knowledge`

에 있을 가능성이 높다.

이 가설을 적극적으로 검토하라.

---

# 3. 목표 아키텍처 가설

현재의

```text
Dooray
  ↓
ETL
  ↓
Ontology Extraction
  ↓
Neo4j
  ↓
GraphRAG
  ↓
Agent

```

구조를 다음처럼 단순화할 수 있는지 검토한다.

```text
Dooray Tasks / Comments / Wiki + Git Repository
             ↓
         Raw ETL
             ↓
     Evidence Normalization
             ↓
   Experience Extraction
             ↓
 ┌───────────────────────────┐
 │ Decision                  │
 │ Constraint                │
 │ Incident                  │
 │ Failed Attempt            │
 │ Lesson Learned            │
 │ Convention                │
 │ Historical Context        │
 └───────────────────────────┘
             ↓
      Knowledge Curation
             ↓
     Compact LLM Wiki
             ↓
      Shallow Retrieval
             ↓
      Claude Code / Codex

```

여기서 중요한 원칙은:

> **Hierarchical Storage가 필요하더라도 Retrieval Interface는 최대한 Flat하게 유지한다.**

Agent가

```text
Graph → Node → Edge → Scenario → Atom → Conversation

```

을 여러 tool call로 탐색하게 만들지 않는다.

이상적인 사용 경험은 다음에 가깝다.

```text
Agent
  ↓
memory search 1회
  ↓
결론 + 맥락 + provenance + 필요 최소 evidence

```

정말 원문 확인이 필요한 경우에만 source를 추가 조회한다.

Memory 결과는 원문을 대체하지 않는다.
각 결과에는 원문을 바로 열 수 있는 link와 안정적인 source identifier를 함께 제공한다.

---

# 4. Karpathy 스타일 LLM Wiki 가설

Memory의 serving representation으로 복잡한 Graph DB보다 **LLM이 읽기 좋은 compact Wiki / Markdown knowledge base**가 더 적절한지 검토하라.

예:

```text
memory/
  projects/
    tc-ocr/
      overview.md

      decisions/
        retry-policy.md
        legacy-auth-retention.md

      constraints/
        backward-compatibility.md
        pg-partial-refund.md

      incidents/
        duplicate-payment-2025-11.md

      failed-attempts/
        output-schema-latency.md

      architecture/
        boundaries.md

      index.md

```

각 문서는 가능한 한 짧고 압축되어 있어야 한다.

예:

```markdown
# Retry count is 3

Status: active
Confidence: high
Last verified: 2026-08-01

## Decision

PG 호출 retry count는 최대 3회로 유지한다.

## Why

5회로 증가시켰을 때 PG가 일부 요청을 중복 승인 요청으로 판단하는 문제가 발생했다.

## Do not

근거 없이 retry를 5 이상으로 올리지 않는다.

## Evidence

- Dooray #123
- comment #456
- incident 2025-11-03

## Related

- payment-timeout
- duplicate-approval

```

중요한 것은 사람이 읽기 좋은 Wiki가 아니라 **Coding Agent가 빠르게 소비할 수 있는 Wiki**라는 점이다.

다음을 검토하라.

- 문서 하나의 적절한 크기
- summary 수준
- provenance 표현
- active / superseded 상태
- confidence
- timestamp
- 관련 source pointer
- project/module scope
- 검색용 metadata
- Markdown frontmatter 필요 여부

---

# 5. Retrieval 전략

Memory retrieval을 복잡한 agent graph traversal로 만들지 않는 방향을 우선 검토한다.

기본적으로 다음과 같은 구조를 고려한다.

```text
User Task
   ↓
Coding Agent
   ↓
필요할 경우 memory search
   ↓
Top few compact memories

```

가능한 구현 후보를 비교하라.

### Option A

ripgrep / filesystem search 중심

### Option B

BM25 / SQLite FTS

### Option C

embedding과 lexical을 결합한 검색

### Option D

LLM 생성 index와 filesystem

### Option E

위 방법들의 얇은 조합

Neo4j / Graph traversal은 기본값으로 두지 않는다.

다만 Graph가 실제로 **비용 대비 명확한 이점을 제공하는 use case가 있다면** 제거하지 말고 근거를 제시한다.

---

# 6. Memory Trigger 문제

가장 중요한 문제 중 하나다.

Memory가 존재하더라도 Agent가 매번 검색하면 안 된다.

다음과 같은 task는 Memory 조회가 필요하지 않을 가능성이 높다.

```text
null check 추가
함수 이름 변경
local refactoring
명확한 compile error 수정

```

반대로 다음과 같은 표현이나 상황에서는 조회 가치가 높다.

```text
왜 이렇게 되어 있지?
기존 동작을 유지해야 한다.
호환성을 깨면 안 된다.
과거 장애가 있었는가?
이 설정을 바꿔도 되는가?
기존 결정은 무엇인가?
migration
production behavior
rollback
legacy
deprecated지만 제거되지 않은 코드

```

하지만 keyword rule만 만들지 않는다.

최종 trigger 판단은 기본적으로 Coding Agent에게 맡기는 방향을 우선 검토한다.

Memory system의 역할은:

```text
어떤 정보를 저장하는가
어떤 정보를 검색 가능한 상태로 만드는가
어떤 결과를 ranking하는가
freshness
provenance
confidence
status

```

Agent의 역할은:

```text
지금 외부 memory가 필요한가
무엇을 검색해야 하는가
결과가 현재 task와 관련 있는가
추가 evidence가 필요한가

```

로 분리하는 것을 검토한다.

---

# 7. Retrieval Cost를 First-Class Metric으로 다뤄라

Memory 기능이 정확하다고 해서 반드시 좋은 것은 아니다.

Memory 때문에 다음이 증가할 수 있다.

- tool calls
- LLM turns
- latency
- input tokens
- context pollution
- 잘못된 historical information 영향
- current source 재확인 비용

따라서 평가에 반드시 다음을 포함한다.

## Baseline

```text
A. Coding Agent only

```

## Agent-triggered Memory

```text
B. Coding Agent
   + memory search tool
   + Agent가 필요할 때 직접 호출

```

## Oracle Memory

```text
C. Coding Agent
   + 사람이 정답 Memory를 정확한 시점에 제공

```

## Automatic Memory

가능하면:

```text
D. Coding Agent
   + automatic retrieval

```

을 추가한다.

비교해야 할 지표:

```text
task success
wrong edit count
test success
wall-clock time
LLM turns
tool calls
source file reads
grep/search calls
memory calls
input tokens
output tokens
rework count

```

특히 다음 개념을 측정 가능한 metric으로 정의한다.

```text
Retrieval Tax

```

그리고

```text
Memory Benefit

```

을 분리한다.

예:

```text
Memory Benefit
= 줄어든 기존 탐색
+ 줄어든 잘못된 구현
+ 줄어든 재작업

```

```text
Retrieval Tax
= memory tool latency
+ 추가 LLM turn
+ 추가 token
+ 불필요한 retrieval

```

최종적으로

```text
Net Memory Utility

```

라는 관점으로 평가할 수 있도록 설계한다.

---

# 8. 현재 devloop-v2 자산을 최대한 재사용하라

기존 코드를 모두 버리는 방향으로 생각하지 않는다.

현재 repository를 직접 조사해서 다음 부분이 얼마나 재사용 가능한지 판단하라.

특히 현재 pipeline은 이미 대략 다음 경계를 가지고 있다.

```text
fetch-dooray
parse-structure
infer-knowledge
resolve
storage

```

다음을 적극적으로 재사용할 방법을 찾는다.

- Dooray fetch
- raw schema
- raw-reader
- hook comment cleanup
- Markdown 보존 처리
- LLM adapter
- inference cache
- concurrency / retry
- project registry
- human curation
- evaluation framework
- ADR / retrospective 문화

현재 Decision extraction도 가능한 한 활용한다.

반대로 아래는 요구사항에 맞지 않는다면 제거 또는 optional layer로 내릴 수 있다.

- 고정 ontology
- Concept explosion
- Neo4j mandatory dependency
- Cypher generation
- graph visualization
- multi-hop GraphRAG
- graph-only evaluation

**기존 구현을 존중하되 sunk cost 때문에 구조를 유지하지 않는다.**

## 지식 원천 범위

지식 저장소는 다음 세 원천을 모두 사용한다.

- Dooray 업무와 댓글
- Dooray Wiki
- Git 저장소의 commit, diff, ADR, retrospective, 운영 문서

Git 원천 저장소는 `/Users/nhn/projects/OCR` 아래의 모든 Git 저장소다.
수집기는 이 원천 저장소를 읽기 전용으로 다루며 파일이나 Git 상태를 변경하지 않는다.

Git 저장소에서는 현재 source를 읽어 재구성할 수 있는 class hierarchy, symbol 위치, caller/callee 같은 정보를 장기 Memory로 복제하지 않는다.

대신 다음처럼 변경 당시의 경험을 보여주는 정보를 우선한다.

- commit message와 연결된 diff가 설명하는 변경 이유
- ADR의 선택, 대안, 결과, superseded 관계
- retrospective와 pitfalls의 실패, 원인, 교훈
- 운영 문서에 남은 제약과 검증 결과

각 Memory는 원천 내용을 복제하지 않고 `source_type`, 안정적인 원천 ID, 원문 URL 또는 repository-relative pointer를 provenance로 보존한다.

URL은 편의 필드이며 식별자의 단일 소스로 사용하지 않는다.
Dooray 주소나 Git remote가 바뀌어도 원천 ID로 link를 다시 만들 수 있어야 한다.

---

# 9. 먼저 Repository Audit를 수행하라

Issue를 만들기 전에 반드시 현재 repository를 충분히 조사한다.

최소한 다음을 확인한다.

```text
README.md
CLAUDE.md
docs/prd.md
docs/flow.md
docs/code-architecture.md
docs/data-schema.md
docs/EVAL-RUBRIC.md
docs/adr/*
docs/pitfalls/*
docs/retrospectives/*
apps/pipeline/*
apps/api/*
packages/shared/*
packages/registry/*
packages/llm/*
.claude/skills/*
eval/*

```

그리고 최근 git history도 확인한다.

```bash
git log

```

특히 commit message 자체에 중요한 experience knowledge가 많이 존재할 수 있으므로 이것도 관찰 대상으로 삼는다.

기존 GitHub Issues도 먼저 읽는다.

```bash
gh issue list --state all

```

중복 Issue를 생성하지 않는다.

---

# 10. 기존 PRD 갱신: Problem Statement

코드를 변경하기 전에 새 문서를 만들지 말고 `docs/prd.md`의 기존 소유 범위 안에서 문제 정의를 갱신한다.

이 문서는 다음을 포함한다.

## Current Problem

현재 GraphRAG 구조가 무엇을 해결하고 있는가.

## New Target

Coding Agent Memory로 사용하려면 무엇이 달라져야 하는가.

## Key Hypotheses

- repository에서 재구성 가능한 knowledge는 memory value가 낮다.
- decision / constraint / incident / failed attempt의 value가 높다.
- shallow retrieval이 graph traversal보다 coding agent에 적합할 수 있다.
- retrieval cost가 memory benefit보다 작아야 한다.

## Unknowns

아직 증명되지 않은 것.

## Success Criteria

무엇이 관찰되면 새로운 방향이 성공했다고 판단할 것인가.

---

# 11. 기존 흐름·아키텍처 문서 갱신

새 문서를 만들지 않는다.
단계 흐름은 `docs/flow.md`, 모듈 책임과 의존 방향은 `docs/code-architecture.md`에 갱신한다.

다음을 포함한다.

```text
Dooray
  ↓
Raw ETL
  ↓
Normalization
  ↓
Experience Extraction
  ↓
Curation
  ↓
Memory Documents
  ↓
Index
  ↓
Agent Retrieval

```

각 단계에 대해:

- responsibility
- input
- output
- deterministic / LLM
- 재실행 비용
- source of truth
- failure mode

를 정의한다.

---

# 12. 기존 데이터 스키마 문서 갱신

Memory schema는 `docs/data-schema.md`에 갱신한다.
코드로 자명하지 않은 장기 결정만 `docs/adr/`에 추가한다.

Memory entity 후보를 먼저 검토한 후 최소 스키마를 제안한다.

초기 후보:

```text
Decision
Constraint
Incident
FailedAttempt
Lesson
Convention

```

무조건 전부 채택하지 않는다.

비슷한 것은 합쳐도 된다.

각 Memory는 최소한 다음 속성이 필요한지 검토한다.

```text
id
title
summary
type
status
scope
confidence
valid_from
valid_until
last_verified
source_refs[]
related_terms[]
source_refs[]

```

특히 status 전이를 반드시 고민한다.

```text
active
superseded
deprecated
uncertain

```

과거 Memory가 현재 사실처럼 사용되는 문제를 방지해야 한다.

---

# 13. 기존 문서의 Retrieval 계약 갱신

Retrieval 흐름은 `docs/flow.md`, interface와 구현 경계는 `docs/code-architecture.md`, 응답 계약은 `docs/data-schema.md`에 갱신한다.

Agent에게 제공할 interface를 최소화한다.

이상적인 API 예:

```text
memory_search(query, scope?)

```

response 예:

```json
{
  "results": [
    {
      "title": "Retry count remains 3",
      "type": "decision",
      "summary": "...",
      "status": "active",
      "confidence": 0.94,
      "evidence": [
        {
          "source_type": "dooray-task",
          "source_id": "123",
          "url": "https://..."
        },
        {
          "source_type": "git-commit",
          "source_id": "abc1234",
          "url": "https://.../commit/abc1234"
        }
      ]
    }
  ]
}

```

가능하면 Agent가 storage architecture를 알 필요 없도록 한다.

다음 같은 API proliferation은 피한다.

```text
search_decision
search_incident
search_scenario
search_atom
search_graph
traverse_relation

```

정말 필요한 경우만 별도 `memory_source(id)` 정도를 고려한다.

---

# 14. GitHub Issues로 작업 분해

위 조사와 제안이 끝난 뒤 실제 구현 계획을 **GitHub Issues로 생성하라.**

Issue는 너무 큰 epic 하나로 끝내지 않는다.

각 Issue는 독립적으로 검증 가능한 단위여야 한다.

가능하면 다음과 같은 milestone 구조를 사용한다.

---

## Milestone 0 — Baseline &amp; Problem Validation

예:

```text
Define Coding Agent Memory baseline benchmark
Measure Claude/Codex behavior without memory
Identify tasks requiring non-code historical context
Define Retrieval Tax metrics

```

---

## Milestone 1 — Experience Extraction

예:

```text
Define Experience Memory schema
Extract Decisions from Dooray
Extract Constraints
Extract Incidents
Extract Failed Attempts
Attach provenance
Handle superseded decisions

```

단, 실제 repository 분석 결과 필요 없는 entity는 만들지 않는다.

---

## Milestone 2 — Compact Memory Wiki

예:

```text
Design memory markdown format
Generate per-project index
Generate compact memory documents
Add status metadata
Add deterministic build

```

---

## Milestone 3 — Shallow Retrieval

예:

```text
Implement lexical baseline
Evaluate SQLite FTS
Evaluate embedding hybrid only if necessary
Expose single memory_search interface
Return evidence with search result

```

처음부터 vector DB를 넣지 않는다.

가장 단순한 기준선에서 시작한다.

---

## Milestone 4 — Coding Agent Integration

예:

```text
Expose memory_search to Claude Code
Expose memory_search to Codex
Define minimal memory usage instruction
Measure voluntary retrieval trigger behavior

```

Agent system prompt에 지나친 trigger rule을 넣지 않는다.

---

## Milestone 5 — Evaluation

예:

```text
Build no-memory baseline
Build oracle-memory benchmark
Measure agent-trigger precision
Measure agent-trigger recall
Measure retrieval timeliness
Measure retrieval tax
Compare wall-clock and task success

```

---

# 15. 각 GitHub Issue 형식

모든 Issue에는 최소 다음이 들어가야 한다.

## Problem

왜 필요한가.

## Hypothesis

이 작업이 무엇을 개선할 것으로 예상하는가.

## Scope

하는 것.

## Non-goals

하지 않는 것.

## Proposed Approach

현재 예상 방법.

단, 아직 실험이 필요한 경우 특정 구현을 정답처럼 못 박지 않는다.

## Acceptance Criteria

객관적으로 완료를 판단할 수 있는 조건.

## Measurement

가능하면 성능 / 품질 측정 방법.

## Dependencies

선행 Issue.

## References

관련 코드 / ADR / 문서.

---

# 16. Spike와 Implementation Issue를 구분하라

아직 답이 없는 문제를 바로 구현 Issue로 만들지 않는다.

예:

잘못된 Issue:

```text
Implement pgvector memory retrieval

```

아직 pgvector가 필요한지 모른다.

대신:

```text
[Spike] Compare filesystem/BM25/vector retrieval for experience memory

```

그리고 결과에 따라 implementation Issue가 생기도록 한다.

마찬가지로 Neo4j 제거도 바로 하지 않는다.

```text
[Spike] Measure whether graph traversal adds value for coding-agent memory tasks

```

를 먼저 수행한다.

---

# 17. 가장 중요한 원칙

이번 작업은

> "새로운 멋진 Memory architecture를 만드는 것"

이 목적이 아니다.

목적은:

> **Claude Code / Codex가 개발 업무를 수행할 때 과거 경험 때문에 생기는 불필요한 재탐색과 잘못된 판단을 실제로 줄이는 것**

이다.

따라서 항상 질문한다.

```text
이 정보는 현재 repository를 읽으면 다시 알 수 있는가?

```

YES라면 Memory에서 제외하는 것을 우선 고려한다.

```text
이 정보가 없으면 Agent가 실제로 잘못된 판단을 할 가능성이 있는가?

```

YES라면 좋은 Memory 후보일 가능성이 높다.

```text
이 Memory를 찾는 비용보다 source를 직접 찾는 비용이 더 큰가?

```

NO라면 Memory에 넣지 않는 것을 고려한다.

---

# 18. 실행 순서

다음 순서로 진행하라.

1. repository 전체 구조 조사
2. 현재 GraphRAG의 실제 책임과 비용 정리
3. 현재 추출 자산 중 재사용 가능한 부분 식별
4. Coding Agent Memory 문제 정의
5. Experience Memory kind와 status 제안
6. Compact Wiki representation 제안
7. 최소 retrieval architecture 제안
8. 평가 전략 작성
9. 기존 Issues와 중복 확인
10. GitHub Issue dependency graph 작성
11. GitHub Issues 생성
12. 최신 Dooray 원문 재수집과 Git 기준 revision 고정
13. 사전 조사 결과가 채택한 최소 Experience Memory 경로 구현
14. 테스트, build, end-to-end utility 평가

Issue 생성과 자체 검토가 끝나기 전에는 production code를 구현하지 않는다.

구현은 한 번에 전체 GraphRAG를 대체하지 않는다.
기존 시스템을 비교군으로 유지하고 독립적으로 검증 가능한 단계로 진행한다.

지식 추출 또는 검색에 LLM이 필요하면 모델은 반드시 `gpt-5.6-luna`를 사용한다.
다른 모델로 조용히 fallback하지 않으며, 사용할 수 없으면 명시적으로 실패한다.
LLM이 필요 없는 정규화, 색인, lexical 검색은 결정적인 구현을 우선한다.

---

# 19. Issue 생성 전 자체 검토

Issue를 생성하기 전에 다음을 스스로 점검한다.

- 특정 기술을 너무 일찍 선택하지 않았는가?
- Neo4j를 없애는 것이 목표가 되어버리지 않았는가?
- 기존 ETL 자산을 불필요하게 버리지 않았는가?
- 코드에서 찾을 수 있는 정보를 다시 Memory화하고 있지 않은가?
- retrieval latency를 무시하고 있지 않은가?
- Agent의 자율적인 탐색 능력을 과소평가하지 않았는가?
- 모든 Issue가 독립적으로 검증 가능한가?
- Spike와 implementation이 분리되어 있는가?
- 성공 기준이 task success까지 연결되는가?
- Memory 자체의 benchmark가 아니라 Coding Agent 전체 성능을 평가하고 있는가?

문제가 있다면 Issue를 생성하기 전에 계획을 수정한다.

---

# 20. GitHub Issue 생성

최종 계획이 정리되면 `gh` CLI를 이용해 실제 Issue를 생성한다.

먼저:

```bash
gh issue list --state all

```

로 중복 여부를 확인한다.

그 다음 각 Issue를 생성한다.

Issue title에는 가능하면 유형을 표시한다.

```text
[Research]
[Spike]
[ETL]
[Memory]
[Retrieval]
[Evaluation]
[Integration]

```

예:

```text
[Research] Define what coding-agent memory should retain
[Spike] Compare shallow retrieval strategies for experience memory
[Memory] Extract code-invisible constraints from Dooray discussions
[Evaluation] Build no-memory vs oracle-memory benchmark

```

Issue 생성 후 최종적으로 다음 형태의 dependency map을 출력한다.

```text
#1 Problem definition
 │
 ├── #2 Baseline benchmark
 │
 └── #3 Experience kind와 status
          │
          ├── #4 Extraction pipeline
          │
          └── #5 Compact Wiki format
                    │
                    └── #6 Retrieval baseline
                              │
                              └── #7 Claude/Codex integration
                                        │
                                        └── #8 End-to-end evaluation

```

그리고 마지막으로 다음 세 가지를 요약한다.

### Keep

현재 devloop-v2에서 그대로 살릴 부분.

### Change

Coding Agent Memory를 위해 변경할 부분.

### Validate Before Building

아직 구현해서는 안 되고 실험으로 먼저 증명할 부분.

---

## 최종 제약

- Issue 분해와 사전 검토가 끝난 뒤 검증된 최소 production code를 구현한다.
- 기존 문서와 코드를 충분히 읽지 않고 Issue를 만들지 않는다.
- 기존 Issue와 중복된 Issue를 만들지 않는다.
- Graph DB 제거를 미리 결론내리지 않는다.
- Vector DB 도입을 미리 결론내리지 않는다.
- Agent Memory 제품들의 구조를 무비판적으로 복제하지 않는다.
- 현재 devloop-v2의 실측 데이터와 평가 문화를 최대한 활용한다.
- 설계의 중심 지표는 Memory recall accuracy가 아니라 **Coding Agent의 end-to-end utility**다.
- Dooray 업무·댓글, Dooray Wiki, Git 저장소를 모두 지식 원천으로 사용한다.
- 모든 Memory에서 안정적인 원천 식별자와 원문 link를 제공한다.
- 지식 추출·검색 LLM은 `gpt-5.6-luna`로 고정하고 fallback하지 않는다.

---

# 21. 전체 Issue 구현 실행 단위

2026-08-13 기준 #4~#8의 production 기준선과 voluntary Agent 통합은 구현되어 main에 병합됐다.
#3과 #9의 end-to-end utility 평가는 Plan014에서 36회 수집과 독립 검증을 마쳤으며, main 병합을 앞두고 있다.
#10~#12는 그 결과가 만든 실제 miss와 비용을 입력으로 사용한다.
모든 Issue를 닫기 위해 다음 순서를 고정한다.

1. source-locked Coding Agent benchmark와 voluntary trigger 계측을 구현한다.
2. #4~#7의 각 acceptance criterion을 코드·실측 근거로 다시 확인한다.
3. no-memory, agent-triggered, oracle-memory를 같은 task와 revision에서 3회씩 실행한다.
4. 실제 miss가 있을 때만 대체 retrieval을 비교한다.
5. 관계형 task에서만 Graph 추가 가치를 비교한다.
6. voluntary 결과 뒤 automatic retrieval의 추가 회수와 오염을 비교한다.

평가 task 원문, 실제 checkout path, 내부 URL, Agent 전문은 ignored private run에 둔다.
공개 suite와 report는 안정 task ID, 분류, hash, 집계, 검증 공백만 남긴다.
task success와 wrong edit가 최우선이며 token은 Agent가 실제 usage를 제공할 때만 기록한다.

현재 아키텍처, 구현 현황, 최종 목표의 사람이 읽는 요약은
[`eval/reports/2026-08-13-project-status.html`](../eval/reports/2026-08-13-project-status.html)에서 관리한다.
별도 prompts, research, memory 관리 문서를 만들지 않고 이 원문과 기존 설계 문서·평가 리포트를 갱신한다.
