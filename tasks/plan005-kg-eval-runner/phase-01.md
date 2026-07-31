# Phase 01 — 평가 스킬과 데이터 계약을 통합한다

**Execution profile**: standard
**Status**: pending

---

## 목표

중복된 `kg-eval-human`·`kg-eval-ai` 절차를 대신할 `kg-eval` 스킬의 계약과 세트 검증기를 만든다.
평가 실행기는 별도 앱이나 패키지가 아니라 스킬의 번들 자원으로 둔다.

설계 근거는 [ADR 0006](../../docs/adr/0006-source-backed-evaluation-skill.md),
`docs/data-schema.md`의 "평가 gold 의 구조", `docs/EVAL-RUBRIC.md` 섹션 3이다.
문서 계약과 구현이 어긋나면 구현을 임의로 바꾸지 말고 조정자에게 보고한다.

**범위 외**

- `/api/query` 반복 호출과 재개 — Phase 02
- tc-ocr 실제 12문항 — Phase 03
- 모델 후보 비교와 기본 모델 변경 — `kg-model-bench`의 독립 관심사
- API·파이프라인·웹 제품 코드 변경

---

## 작업 항목 (4)

### 1. `kg-eval` 스킬 골격을 만든다

`skill-creator`의 초기화 스크립트로 `.claude/skills/kg-eval/`을 만든다.
필요한 자원은 `scripts/`, `references/`, `agents/openai.yaml`이다.

`SKILL.md`는 다음 절차만 소유한다.

1. 사전 점검과 평가 세트 검증
2. 문항별 3회 직렬 실행과 중단 후 재개
3. 원천·그래프·검색·답변 경계 분리
4. 두 독립 의미 판정과 불일치 `REVIEW`
5. JSON·Markdown 리포트와 이전 기준선 비교

사람형과 AI 에이전트형 질문은 각각 `audience=human`, `audience=ai`로 구분한다.
모델 비교 절차나 후보 목록은 넣지 않는다.

### 2. 결과 계약을 참조 문서로 분리한다

`.claude/skills/kg-eval/references/result-contract.md`에 다음 JSON 계약을 구체화한다.

- 세트 최상위: `schemaVersion`, `project`, `flowId`, `title`, `sourceSnapshot`, `questions`
- 문항: `id`, `audience`, `difficulty`, `question`, `answerability`, `sourceRefs`, `graphChecks`,
  `requiredEvidence`, `supportingEvidence`, `orderedEvents`, `expectedClaims`, `forbiddenClaims`
- 원시 실행: 실행 조건과 최상위 `attempts` 배열. 각 항목은 문항·회차, HTTP 결과, 응답 시간,
  원본 `answer`·`evidence`·`cypher`를 가진다
- 요약: 최상위 `questions` 배열. 각 항목은 결정적 검사, 의미 판정 둘, 안정성,
  `finalVerdict`인 `PASS|FAIL|REVIEW`, 실패 경계를 가진다

`SKILL.md`는 이 세부 형식을 복제하지 않고 필요한 시점에 참조 문서를 읽도록 안내한다.

### 3. `validate-suite.mjs`를 만든다

Node.js 기본 기능만 사용한다. 명령 계약은 다음과 같다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/validate-suite.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --data-root apps/pipeline/data
```

검사 항목은 다음과 같다.

- 필수 필드·열거값·문항 id 유일성
- 최소 12문항, `human`·`ai`, L1~L5 포함
- `answerable` 문항의 `sourceRefs`·`requiredEvidence` 존재
- `insufficient-source` 문항의 `forbiddenClaims` 존재와 `requiredEvidence` 부재
- `sourceRefs`가 `apps/pipeline/data/raw/<project>/posts/<task>.json`의 `post.number`, `post.id`,
  `comments[].id` 중 선언한 종류에 실제 존재
- `orderedEvents`, `requiredEvidence`, `supportingEvidence`가 선언된 `sourceRefs` 밖을 가리키지 않음

실패는 문항 id와 필드 경로를 표준 오류에 출력하고 종료 코드 1로 끝낸다.

### 4. 검증기 단위 테스트를 만든다

`.claude/skills/kg-eval/tests/validate-suite.test.mjs`에 임시 fixture를 사용한 Node 내장 테스트를 둔다.
정상 세트와 각 거부 조건을 최소 한 번씩 검증한다.

가드가 실제로 작동하는지 확인하려고 정상 fixture의 `sourceRefs` 하나를 존재하지 않는 댓글 id로 바꿨을 때
테스트가 실패하는 것을 확인하고 즉시 원복한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/SKILL.md` | 신규 |
| `.claude/skills/kg-eval/agents/openai.yaml` | 신규 |
| `.claude/skills/kg-eval/references/result-contract.md` | 신규 |
| `.claude/skills/kg-eval/scripts/validate-suite.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/validate-suite.test.mjs` | 신규 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/validate-suite.test.mjs
python3 /Users/nhn/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/kg-eval
git diff --check
```

테스트 실패 가드를 의도적으로 깨뜨렸을 때 실패한 명령과 원복 후 통과한 명령을 phase 보고에 남긴다.

## 의도 메모 (왜)

- 긴 JSON 계약을 `SKILL.md`에 넣지 않는 이유는 평가 때마다 불필요한 문맥을 차지하기 때문이다.
- 원천 참조를 먼저 검사하는 이유는 그래프에서 만든 정답으로 그래프를 채점하는 순환 검증을 막기 위해서다.
- 새 의존성을 쓰지 않는 이유는 평가가 제품 런타임이나 독립 배포 단위가 아니기 때문이다.

## Blocked 조건

- 원천 데이터가 `apps/pipeline/data/raw/tc-ocr/posts/`에 없으면
  `PHASE_BLOCKED: tc-ocr 원천 데이터 부재`를 출력하고 fixture 단위 테스트까지만 완료한다.
