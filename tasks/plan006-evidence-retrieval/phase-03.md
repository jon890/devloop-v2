# Phase 03 — 적재하고 엔진 변경 효과를 기준선과 비교한다

**Execution profile**: standard
**Status**: completed

---

## 목표

Phase 01·02 의 변경을 그래프에 반영하고, 근거 회수 실패가 실제로 줄었는지 판정한다.

plan005 기준선은 12문항 × 3회에서 실패 경계가 `RETRIEVAL` 19 · `ANSWER` 2 · `GRAPH` 0 이었다.
이번 목표는 **`RETRIEVAL` 19건을 줄이는 것**이다. 최종 PASS 수를 목표로 삼지 마라 —
36회 중 22회가 채점자 불일치로 `REVIEW` 이고 12문항 중 10문항이 실행 간 불안정해서
의미 판정으로는 개선을 읽을 수 없다.

**이 phase 는 평가 세트를 절대 건드리지 않는다.** `compare.mjs:73-75` 가 세트 해시가 다르면
예외를 던지므로, gold 를 한 글자만 고쳐도 plan005 기준선과 비교가 불가능해진다.

**범위 외**

- gold 하향 — Phase 04
- 코드 변경 — Phase 01·02 에서 끝난다

---

## 작업 항목 (5)

### 1. 그래프에 반영한다

되돌릴 수 없는 단계가 없다. 적재기가 `SET n += row.properties`(`sync.ts:83-84`)로 속성을
덮어쓰므로 **초기화가 필요 없다.** `reset-neo4j` 를 실행하지 마라.

```bash
# cwd: 저장소 루트
D="$(pwd)/apps/pipeline/data"
pnpm --filter pipeline parse-structure --project tc-ocr
pnpm apply-schema
pnpm --filter pipeline sync-neo4j --project tc-ocr --data-dir "$D"
```

`--data-dir` 에는 절대 경로를 쓴다. 상대 경로는 pipeline 패키지 기준으로 풀려 파일을 못 찾는다.

### 2. 그래프가 예상대로 바뀌었는지 확인한다

적재 전후로 아래를 비교하고 리포트에 적는다. **노드와 관계 수가 전부 불변이어야 한다.**

| 항목 | 기대값 |
| --- | --- |
| 노드 | 3,082 (Comment 854 포함) |
| 관계 | 13,002 |
| `REFERENCES` | 328 |

속성만 바꾸는 변경이므로 수가 달라지면 Phase 01 의 머리말 벗기기가 의도보다 넓게 걸린 것이다.
그 자리에서 멈추고 원인을 보고한다.

인덱스도 확인한다.

```bash
# cwd: 저장소 루트
docker exec devloop-v2-neo4j-1 cypher-shell \
  -u "${NEO4J_AUTH%%/*}" -p "${NEO4J_AUTH#*/}" --format plain \
  "SHOW INDEXES YIELD name, type WHERE type='FULLTEXT' RETURN name ORDER BY name;"
```

5개가 나와야 한다.

### 3. dev 서버를 재시작한다

코드가 바뀌었으므로 API 를 다시 띄운다. 낡은 프로세스가 새 계약을 만족하지 못해 화면이 비는
사고가 실제로 났다. 재시작 후 `/api/graph/stats` 가 응답하는지 확인한다.

### 4. 36회를 재측정한다

측정 중에 같은 API 로 브라우저 질의를 하지 마라. LLM CLI 호출이 경쟁해 결과가 불안정해진다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --stage plan006-engine \
  --api-base-url http://localhost:3000 \
  --query-model gpt-5.6-terra \
  --repeats 3 \
  --out eval/runs/plan006-engine.json
```

질의 모델은 `.env` 의 `QUERY_LLM_MODEL` 값을 읽어 명시한다.

**질의 소요 시간을 함께 기록한다.** 근거 텍스트가 길어져 답변 합성 프롬프트가 커지므로,
회수가 좋아지는 대신 시간이 얼마나 늘었는지가 이번 변경의 대가다.

### 5. 기준선과 비교한다

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/compare.mjs \
  --baseline eval/reports/2026-07-31-plan005-baseline.json \
  --candidate eval/reports/<실행일>-plan006-engine.json
```

`suiteHash` 가 같아야 실행된다. 예외가 나면 평가 세트가 바뀐 것이므로 되돌린다.

리포트(`eval/reports/`)에 남길 것이다.

- 실패 경계 분포 전후 비교 — `RETRIEVAL` 이 19 에서 몇으로 갔나
- 문항별 판정 변화. 개선과 회귀를 각각 나열한다
- 그래프 스냅샷 (노드·관계·Concept 수)
- 질의 소요 시간 전후
- **몇 문항을 실제로 측정했는지.** 부분 재측정으로 전체를 단정한 사고가 이 저장소에 있었다

원시 실행 결과(`eval/runs/`)는 gitignore 대상이라 커밋하지 않는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/reports/<실행일>-plan006-engine.json` | 신규 |
| `eval/reports/<실행일>-plan006-engine.md` | 신규 |

`<실행일>` 은 측정을 돌린 날짜를 `YYYY-MM-DD` 로 채운다 (기존 리포트 명명 규칙과 같다).

## 검증

- 전문 검색 인덱스가 5개다
- 노드 3,082 · 관계 13,002 · `REFERENCES` 328 이 불변이다
- 36회 전부 완료됐다 (12문항 × 3회)
- `compare.mjs` 가 예외 없이 실행됐다
- 리포트에 실제 측정 문항 수와 소요 시간이 적혀 있다

**회수 실패가 늘었으면 회귀로 단정하기 전에 원인을 확인한다.** 검색 대상이 넓어져 앵커 경쟁이
심해졌을 수 있다. 그 경우 어느 문항이 어떤 앵커를 잡았는지 실측해 보고하고, 상한을 임의로
조정하지 마라.

## 의도 메모 (왜)

- **gold 를 건드리지 않는 이유** — 세트 해시가 바뀌면 plan005 기준선과 비교가 영영 불가능하다.
  엔진 효과를 먼저 도구로 측정하고, 기준 변경은 Phase 04 로 미룬다
- **초기화하지 않는 이유** — 속성만 바뀌므로 MERGE 로 갱신된다. 되돌릴 수 없는 작업을 이유 없이 하지 않는다
- **PASS 수를 목표로 삼지 않는 이유** — 의미 판정이 채점자 불일치로 흔들려 개선을 읽을 수 없다.
  결정적 축인 회수 실패만 목표로 둔다
