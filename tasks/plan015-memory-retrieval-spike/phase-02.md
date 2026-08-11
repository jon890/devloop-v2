# Phase 02 — 세 retrieval adapter를 격리 구현한다

**Execution profile**: deep
**Status**: pending

---

## 목표

실제 miss가 있을 때만 같은 Wiki index와 top-k에서 Node lexical, SQLite FTS5, local dense embedding hybrid를 비교하는 평가 adapter를 구현한다.

**범위 외**: production `memory-search` 변경, vector DB, 새 서비스, 원격 embedding API, LLM query expansion.

---

## 작업 항목 (5)

### 1. 공통 adapter 계약을 만든다

`.claude/skills/kg-eval/scripts/memory/retrieval/adapter.mjs`는 `build(documents)`와 `search(query, topK)`를 정의한다.
모든 adapter는 같은 document ID, corpus, top-k를 받고 buildMs, searchMs, indexBytes, peakRssDelta, dependencyCount, serviceCount를 반환한다.

### 2. 기존 lexical 기준선을 감싼다

`lexical.mjs`는 production ranking을 import하거나 동일 함수를 직접 호출하며 점수 규칙을 복제하지 않는다.
현재 `memory-search` 결과와 ID·순서가 byte-identical이어야 한다.

### 3. SQLite FTS5 adapter를 구현한다

`sqlite-fts.mjs`는 Node 24 내장 `node:sqlite`와 in-memory FTS5를 사용한다.
외부 package와 장기 DB 파일을 만들지 않고 실패 시 지원 여부를 명시한다.

### 4. local dense embedding hybrid를 구현한다

`hashed-ngram-hybrid.mjs`는 정규화한 word·character n-gram을 고정 차원 dense vector로 feature hashing하고 cosine score와 lexical score를 결합한다.
차원, seed, 가중치는 상수로 고정하고 query마다 model이나 LLM을 호출하지 않는다.
이 방식이 의미 모델 embedding이 아니라는 제한을 report에 명시한다.

### 5. 동일성·결정성 테스트를 추가한다

corpus와 top-k 불일치 거부, tie-break, repeated byte equality, SQLite availability, hybrid seed 결정성을 테스트한다.
평가 adapter가 production import graph에 들어가지 않는 것도 정적 검사한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/memory/retrieval/adapter.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/retrieval/lexical.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/retrieval/sqlite-fts.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/retrieval/hashed-ngram-hybrid.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/compare-memory-retrieval.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/memory-retrieval.test.mjs` | 신규 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-retrieval.test.mjs
node .claude/skills/kg-eval/scripts/compare-memory-retrieval.mjs --help
rg -n "node:sqlite|hashed-ngram" apps packages
git diff --check
```

`rg`는 0줄이어야 하며 평가 adapter가 production 코드로 들어가면 안 된다.

## 의도 메모 (왜)

- local dense adapter는 별도 service 없이 embedding hybrid의 최소 운영 비용을 비교하기 위한 평가 구현이다.
- SQLite 파일을 남기지 않는 이유는 production storage 도입으로 오해하지 않게 하기 위해서다.

## Blocked 조건

- Phase 01의 실제 miss가 0건이면 adapter 파일을 만들지 않고 `PHASE_NOT_TRIGGERED: lexical miss 0`으로 보고한다.
