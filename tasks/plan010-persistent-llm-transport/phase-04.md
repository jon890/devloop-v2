# Phase 04 — API 응답 계약을 outputSchema 로 옮기고 JSON 재시도를 없앤다

**Execution profile**: standard
**Status**: pending

---

## 목표

지금은 프롬프트에 **글로 부탁한다** — "응답은 반드시 JSON 하나만 출력한다".
모델이 어기면 `completeStructured` 가 오류를 붙여 **같은 요청을 한 번 더 보낸다** (`:415-433`).
형식이 틀릴 때마다 호출이 두 배다.

`turn/start` 의 `outputSchema` 는 그 부탁을 서버에 규격으로 넘긴다. 실측이다.
형식 지시를 한 글자도 넣지 않고 비교했다.

| | 응답 | 계약 준수 |
| --- | --- | --- |
| `outputSchema` 있음 | `{"terms":[...]}` | 예 |
| `outputSchema` 없음 | 산문 (`다음 키워드로...`) | 아니오 |

**이 phase 는 Phase 02 가 만든 상주 어댑터와 Phase 03 의 측정 기준을 전제한다.**

**범위 외**

- 파이프라인 추출 — `outputSchema` 를 넣지 않는다. 추출 스키마가 `@devloop/shared` 의 zod 3
  스키마를 참조해 계약 패키지까지 v4 로 올려야 하고, `superRefine` 의 교차 필드 규칙은
  JSON Schema 로 표현할 수 없어 재시도가 남는다. 프롬프트를 바꾸면 캐시 537건이 무효화된다
- `@devloop/shared` 의 스키마 — **건드리지 마라**
- 프롬프트의 내용 지시 — 아래 3번이 정한 것만 뺀다

---

## 작업 항목 (4)

### 1. LLM 응답 스키마 3개만 zod v4 로 올린다

`apps/api/src/query/query.schema.ts:3-5` 의 세 줄이다.

```ts
export const AnchorResponseSchema = z.object({ terms: z.array(z.string().min(1)).min(1) });
export const CypherResponseSchema = z.object({ cypher: z.string().trim().min(1) });
export const AnswerResponseSchema = z.object({ answer: z.string().trim().min(1) });
```

설치된 `zod@3.25.76` 은 `zod/v4` 하위 경로로 v4 를 함께 담고 있다.
그 경로의 `toJSONSchema` 로 JSON Schema 를 얻는다. 실측으로 확인했다.

- `z.string().trim().min(1)` → `{"type":"string","minLength":1}` 로 변환된다
- `z.array(z.string().min(1)).min(1)` → `minItems`·`items.minLength` 로 변환된다
- 세 스키마는 `query.service.ts` 만 쓴다. 다른 곳에서 참조하지 않으므로 파급이 없다

**v4 객체 안에 zod 3 스키마를 넣으면 실패한다** (`Cannot read properties of undefined (reading 'def')`).
이 세 스키마는 외부 스키마를 참조하지 않으므로 문제가 없다. 다른 스키마를 v4 로 올리지 마라.

같은 파일에 다른 스키마가 있으면 그것들은 zod 3 으로 남긴다. 한 프로세스에서 두 버전이
공존하는 것은 확인했다.

### 2. 어댑터에 outputSchema 를 실어 보낸다

`completeStructured` 가 zod 스키마를 이미 받는다. 그 스키마에서 JSON Schema 를 만들어
`complete` 의 `outputSchema` 로 넘긴다.

**변환을 호출마다 다시 하지 마라.** 스키마는 상수이므로 한 번 만들어 재사용한다.

### 3. 프롬프트에서 형식 지시만 뺀다

**형식 문구는 정확히 5줄이다.** 전수 확인했다.

| 위치 | 문구 |
| --- | --- |
| `:237` | `"응답은 반드시 JSON 하나만 출력한다."` |
| `:238` | `'형식: {"terms":["원문 핵심 용어","영어 또는 한국어 표기 변형"]}'` |
| `:256` | `'응답은 반드시 JSON 하나만 출력한다. 형식: {"cypher":"MATCH ... RETURN ... LIMIT 50"}'` |
| `:297` | `'응답은 반드시 JSON 하나만 출력한다. 형식: {"cypher":"MATCH ... RETURN nodes, relationships, paths LIMIT 50"}'` |
| `:399` | `'응답은 반드시 JSON 하나만 출력한다. 형식: {"answer":"답변"}'` |

**두 줄(`:256`·`:297`)에는 내용 지시가 섞여 있다.** 통째로 지우면 내용이 함께 사라진다.

- `LIMIT 50` 의 **명시 지시는 이 두 줄에만 있다.** 지우면 few-shot 예시(`:265`·`:274`)에만 남는다.
  행 상한을 요구하는 내용 지시 한 줄을 대신 적어라
- `:297` 의 `RETURN nodes, relationships, paths` 는 같은 프롬프트의 다른 줄
  ("관련 node, relationship, path만 별도로 반환하라") 이 이미 담고 있어 중복이다

**내용 지시는 남긴다.** 스키마는 모양만 보장하고 내용은 보지 않는다 — 실측에서 모델이
`terms` 배열 안에 설명을 섞어 넣었다. 앵커 프롬프트의 표기 변형 규칙·조사 제외 규칙 같은
내용 지시를 함께 지우면 앵커 품질이 떨어진다.

### 4. JSON 계약 재시도를 없앤다

`completeStructured`(`:415-433`) 의 2회 루프와 `:427` 의 재시도 프롬프트를 제거한다.

**zod 검증은 남긴다.** 서버가 형식을 보장하더라도 검증을 지우면 계약이 깨졌을 때 조용히
넘어간다. 검증 실패는 **즉시 오류로 올린다** — 재시도로 덮으면 계약 결함이 드러나지 않는다.

Cypher 실행 실패 시의 재생성(`:308` 경로)은 **그대로 둔다.** 그건 형식 문제가 아니라
Cypher 가 실행되지 않은 것이라 성격이 다르다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/api/src/query/query.schema.ts` | 수정 — 응답 스키마 3개를 v4 로 |
| `apps/api/src/query/query.service.ts` | 수정 — 프롬프트 5줄, `completeStructured` |
| `apps/api/test/cypher-prompt.test.js` | 수정 — 프롬프트 검증이 있으면 맞춘다 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter @devloop/llm test
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

형식 문구가 정말 다 빠졌는지 센다. **출력이 0줄이어야 한다.**

```bash
# cwd: 저장소 루트
grep -n "JSON 하나만" apps/api/src/query/query.service.ts
```

내용이 안 사라졌는지도 센다. **행 상한 지시가 한 줄 이상 남아야 한다.**

```bash
# cwd: 저장소 루트
grep -c "LIMIT" apps/api/src/query/query.service.ts
```

새 테스트가 덮어야 할 것이다.

- 세 스키마가 JSON Schema 로 변환되고 `required` 와 길이 제약이 담긴다
- `completeStructured` 가 검증 실패 시 **재시도하지 않고 즉시 오류를 올린다**
- 어댑터 호출 인자에 `outputSchema` 가 실린다
- 프롬프트에 형식 문구가 없고 내용 지시는 남아 있다

**변이 검증** — `outputSchema` 전달을 빼고 해당 테스트가 실제로 실패하는지 확인한 뒤 원복한다.

실제 `codex` 로 질의 한 건을 돌려 답이 계약을 지키는지 확인한다. 방법은 Phase 02 의 5번과 같다.

## 의도 메모 (왜)

- **검증을 남기는 이유** — 서버 보장을 믿고 검증을 지우면 계약이 깨진 날 조용히 넘어간다.
  검증은 싸고 실패는 드러나야 한다
- **재시도를 없애는 이유** — 형식 위반이 원리적으로 안 생기므로 재시도 경로는 죽은 코드가 된다.
  남겨 두면 "왜 있나" 를 다음 사람이 다시 조사한다
- **형식 줄만 빼는 이유** — 실측에서 스키마가 모양만 보장하고 내용은 안 봤다.
  내용 지시를 함께 빼면 지연을 고치려던 변경이 답변 품질을 깎는다
- **파이프라인을 제외한 이유** — ADR 0008 의 기각 표에 있다. 계약 패키지 연쇄 이전과
  캐시 537건 무효화를 지연 개선 plan 에서 지불할 이유가 없다
