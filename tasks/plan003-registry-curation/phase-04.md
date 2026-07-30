# Phase 04 — 승인된 판단을 주입하고 병합 효과를 적재 없이 확인한다

**Execution profile**: standard
**Status**: pending

---

## 목표

승인된 판단을 실제로 넣고, **무엇이 합쳐지는지 적재 없이 확인한다.**
이것이 `resolve-graph` 를 만든 이유이고 별칭 등록을 여기까지 미뤄 둔 이유다.

**범위 외**

- 그래프 재적재. 초기화가 필요하므로 사용자 판단 대상이다. 아래 5번 참조
- 품질 측정(평가 스킬 실행). 재적재 후에 할 일이다
- 보류된 2쌍(`Document AI` 계열) 등록. 사람이 이름 관계를 먼저 정해야 한다

---

## 주입할 판단

근거는 `eval/reports/2026-07-28-concept-alias-candidates.md` 에 있다.
**그 리포트를 읽고 `reason` 을 옮겨 적어라.** 요약하지 말고 근거가 살아 있게 옮긴다.

### 병합 5쌍 (승인됨)

| 그룹 | canonical | 흡수할 표기 |
| --- | --- | --- |
| A | `OCR API Gateway` | `api gateway`, `Gateway` |
| B | `Document Recognizer AI` | `document recognizer` |
| C | `Vehicle Plate Recognizer AI` | `vehicle plate ocr`, `Vehicle`, `Plate` |

### 차단 (기존 전역 상수에서 이관)

| 키 | 이유 |
| --- | --- |
| `analysis` | `/analysis` 는 API 경로이고 `analysis` 는 일반 코드 참조다 |
| `cloudtoastcom` | 와일드카드 도메인과 개별 호스트는 다르다 |

### 차단 (새로 추가)

| 키 | 이유 |
| --- | --- |
| `gateway api` | 쿠버네티스 표준 Gateway API 다. `api gateway` 와 토큰 집합이 같지만 다른 개체다 |
| `nat gateway` | 위와 같은 이유로 별개다 |

**마지막 둘이 중요하다.** 그룹 A 가 `api gateway` 를 흡수하므로,
토큰 집합이 같은 `gateway api` 가 같은 규칙에 걸려들지 않는지 확인해야 한다.

---

## 작업 항목 (4)

### 1. 주입 파일을 만든다

`packages/registry/src/curation.schema.ts` 의 계약에 맞춰 JSON 을 만든다.

- **저장소 안에 두지 마라.** 판단 데이터는 커밋하지 않는다.
  `/tmp` 또는 사용자가 지정한 저장소 밖 경로에 두고 그 경로를 보고에 적어라
- `reason` 은 리포트의 근거를 옮긴다. 비워 두면 스키마가 거부한다

주입 전에 프로젝트와 소스를 멱등 등록한다.

```bash
# cwd: 저장소 루트
pnpm --filter pipeline register-project --code tc-ocr --name tc-ocr \
  --source-kind dooray --source-key tc-ocr
```

### 2. dry-run 으로 먼저 본다

```bash
# cwd: 저장소 루트
pnpm --filter pipeline import-curation --project tc-ocr --file <절대경로> --dry-run
```

거부되는 행이 있으면 **넣지 말고 원인을 보고하라.** 특히 아래를 확인한다.

- `Gateway` 가 이미 다른 판단에 지배되고 있지 않은지
- 같은 별칭이 두 canonical 에 붙지 않았는지

### 3. 주입 전후 `resolved.jsonl` 을 비교한다 — 이 phase 의 핵심

```bash
# cwd: 저장소 루트
D="$(pwd)/apps/pipeline/data"
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D" --out /tmp/before.jsonl
pnpm --filter pipeline import-curation --project tc-ocr --file <절대경로>
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D" --out /tmp/after.jsonl
diff /tmp/before.jsonl /tmp/after.jsonl > /tmp/curation.diff
```

`diff` 를 읽고 다음을 판정해 보고하라.

- **사라진 Concept 노드가 흡수 대상 6종과 정확히 일치하는가** —
  `api gateway`·`Gateway`·`document recognizer`·`vehicle plate ocr`·`Vehicle`·`Plate`
- 관계의 끝점이 표준어로 옮겨졌는가
- **의도하지 않은 병합이 있는가.** 있으면 그것이 가장 중요한 발견이다.
  `gateway api`·`nat gateway` 가 살아 있는지 반드시 확인하라

의도하지 않은 병합이 보이면 **되돌린다.**

```bash
# cwd: 저장소 루트
pnpm --filter pipeline import-curation --project tc-ocr --file <빈 판단 파일> --replace
```

되돌릴 수 있다는 것이 이 단계를 만든 이유다. 그래프를 건드리기 전에 확인한다.

### 4. legacy 차단 fallback 을 제거하고 보관본을 만든다

차단 4건이 DB 에 들어가고 위 diff 판정이 통과한 뒤,
Phase 03 에서 임시 유지한 코드 fallback 2건을 제거한다.

- 제거 뒤 `resolve-graph` 를 다시 실행해 fallback 제거 전 산출물과 바이트가 같은지 확인한다
- 다르면 DB 차단이 코드 fallback 을 완전히 대체하지 못한 것이므로 원복하고 보고한다
- `CONCEPT_KEY_CANONICAL_OVERRIDES` 와 legacy denylist 값이 코드에 0건인지 grep 으로 확인한다

```bash
# cwd: 저장소 루트
pnpm --filter pipeline export-curation --project tc-ocr --out <저장소 밖 절대경로>
```

- 두 번 뽑아 `cmp` 로 바이트 동등을 확인한다
- **저장 위치는 조정자에게 물어라.** 비공개 보관 방식이 아직 정해지지 않았다.
  정해지기 전까지는 경로를 보고에 남기고 사용자가 옮길 수 있게 한다

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| 주입 JSON | 신규 — **저장소 밖에 둔다** |
| `docs/data-schema.md` | 확인만. 판단 저장소 절이 실제와 맞는지 |
| `apps/pipeline/src/resolve/concept-alias.const.ts`·관련 공유 모듈 | 수정 — DB 주입 확인 뒤 legacy fallback 제거 |
| `CLAUDE.md` | 수정 — 진행 표에서 별칭 등록 항목을 완료로 바꾼다 |

fallback 제거 외 코드 변경은 없어야 한다.
다른 변경이 필요해지면 앞 phase 에 빠진 것이 있다는 뜻이므로 **보고하라.**

---

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter api test:unit
pnpm --filter pipeline test
```

개수가 Phase 03 결과에서 줄지 않았는지 확인하라.

### 재생성 견디기 재확인

Phase 03 이 판단 1건으로 확인했다. 여기서는 **실제 5쌍으로** 다시 확인한다.

```bash
# cwd: 저장소 루트
pnpm --filter pipeline seed-concepts --project tc-ocr
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D" --out /tmp/after2.jsonl
cmp /tmp/after.jsonl /tmp/after2.jsonl && echo "재생성 후에도 판단 유지"
```

차이가 나오면 판단이 재생성을 견디지 못한 것이다. **Phase 03 이 불완전하다는 뜻이므로 보고하라.**

### 그래프 재적재는 하지 않는다

적재기가 MERGE 전용이라 재적재만으로는 파편 노드가 남는다.
효과를 보려면 초기화가 필요하고, 그것은 **되돌리기 어려운 작업**이라 사용자 판단 대상이다.

`diff` 판정 결과를 보고하고 **여기서 멈춘다.** `reset-neo4j` 를 실행하지 마라.

---

## 의도 메모 (왜)

- **주입 파일을 저장소 밖에 두는 이유** — 판단은 조직 내부 이름과 업무 번호를 담는다.
  스키마는 커밋하고 데이터는 커밋하지 않는 것이 이 설계의 전제다
- **dry-run 을 먼저 하는 이유** — 판단은 사람이 근거를 확인한 결론이지만
  키 정규화가 예상과 다르게 걸릴 수 있다. 넣기 전에 거부 여부를 본다
- **`gateway api` 를 명시적으로 차단하는 이유** — `api gateway` 와 토큰 집합이 완전히 같은데
  다른 개체다. 자동 병합이 왜 불가능한지 보여 주는 실측 사례라 이번에 함께 못박는다
- **재적재를 하지 않는 이유** — 그래프 초기화는 되돌릴 수 없고, 효과 판정에는 `diff` 로 충분하다.
  파일 비교로 확인할 수 있는 것에 되돌릴 수 없는 작업을 쓰지 않는다

---

## 마지막 phase 마무리

이 plan 의 마지막 phase 다. 검증을 모두 통과한 뒤 다음을 처리한다.

- `tasks/plan003-registry-curation/index.json` 에서 이 phase 의 `status` 를 `completed` 로 바꾼다
- 네 phase 가 모두 `completed` 이면 최상위 `status` 도 `completed` 로 바꾼다
- 어느 phase 든 `PHASE_BLOCKED` 로 끝났으면 **`completed` 로 바꾸지 말고** 그 사유를 보고한다

보고에 반드시 담을 것이다.

- `diff` 판정 — 사라진 Concept 이 흡수 대상과 일치하는지, 의도하지 않은 병합이 있는지
- 보관본 경로
- 재적재가 남아 있다는 사실과 그것이 사용자 판단 대상이라는 것
