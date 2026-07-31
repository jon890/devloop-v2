# Phase 03 — API Gateway 제거 대표 흐름 평가 세트를 만든다

**Execution profile**: deep
**Status**: pending

---

## 목표

tc-ocr API Gateway 제거의 결정부터 이전·크기 상향·등가성·부하 검증까지를 묻는
원천 근거 기반 12문항을 만든다.

정답은 `apps/pipeline/data/raw/tc-ocr/posts/*.json`에서 먼저 확정한다.
그래프나 `/api/query` 응답을 보고 `expectedClaims`·`sourceRefs`를 만들거나 고치지 않는다.

**범위 외**

- 490개 업무 전체의 자동 문항 생성
- 원천에 없는 관계를 그럴듯한 gold로 채우기
- Concept 병합 후보 평가와 승인 화면
- 원천 문서나 그래프 데이터 수정

---

## 작업 항목 (4)

### 1. 대표 흐름의 원천 근거 패킷을 확정한다

다음 업무와 댓글을 직접 읽고 task 번호, Dooray 내부 id, 댓글 id, 안전하게 말할 수 있는 주장,
말하면 안 되는 인과를 정리한다.

| 역할 | 업무 |
| --- | --- |
| 제거 결정과 전체 계획 | 483 |
| alpha·beta 공인 진입점과 trust 복구 | 494 |
| rewrite 23건 이전 | 496 |
| 전 구간 크기 제한 상향과 선행 검증 | 497 |
| APIGW·공인 경로 등가성 검증 | 498 |
| 대용량 요청 부하 검증과 남은 병목 | 499 |
| real 공인 진입점·배포 순서 | 506 |
| 음성 대조 원천 | 491, 501, 502 |

원천 패킷은 별도 원문 복사 파일로 만들지 않고 각 문항의 `sourceRefs`, `expectedClaims`,
`forbiddenClaims`에 필요한 최소 정보만 넣는다.

### 2. 답변 가능 문항 10개를 만든다

`eval/suites/tc-ocr-api-gateway.json`에 아래 의도를 각각 한 문항으로 만든다.

| id | 질문 의도 |
| --- | --- |
| `AGW-H01` | 제거를 시작한 이유와 실제로 함께 풀어야 했던 제한 |
| `AGW-H02` | API Gateway가 하던 역할과 이전 대상 |
| `AGW-H03` | 공인 LB 발급 실패의 공통 증상, 근본 원인, 해결 조치 |
| `AGW-H04` | 크기 제한 상향 전 발견한 모델 서버 병목과 후속 조치 |
| `AGW-H05` | 20MB 부하검증의 최초 실패, 메모리 상향, 남은 병목 |
| `AGW-A01` | Phase B 업무 496~499의 목적과 검증 순서 |
| `AGW-A02` | 497의 설정 변경이 499에서 검증된 과정 |
| `AGW-A03` | 498의 등가성 검사 대상·판정·재사용 지점 |
| `AGW-A04` | 494에서 506으로 이어진 환경별 공인 진입점 전개와 순단 작업 분리 |
| `AGW-A05` | 483의 결정부터 진입점·rewrite·상향·등가성·부하검증까지 전체 흐름 |

각 문항은 `human` 또는 `ai`, L1~L5, 필수·보강 근거, 순서, 그래프 검사,
직접 지지되는 주장과 금지 주장을 가져야 한다.
H1~H5·A1~A5 패턴과 L1~L5가 세트 전체에서 모두 포함돼야 한다.

### 3. 음성 대조 2개를 만든다

다음 문항은 `answerability=insufficient-source`로 둔다.

- `AGW-N01`: 업무 491의 RST 장애가 업무 483의 API Gateway 제거를 직접 유발했는가.
  두 업무 사이 직접 인과나 참조가 원천에 없으므로 인과를 단정하면 실패다.
- `AGW-N02`: 업무 501과 502가 직접 의존하거나 서로를 유발했는가.
  주제가 가깝더라도 직접 관계가 원천에 없으므로 관계를 단정하면 실패다.

두 문항은 검색 실패 분모에 넣지 않는다.
원천 부재와 허용 가능한 답변 형태를 `expectedClaims`, 금지 인과를 `forbiddenClaims`로 명시한다.

### 4. 세트 검증과 오염 점검을 수행한다

Phase 01 검증기를 실행하고 다음 수치를 확인한다.

- 전체 12문항
- 답변 가능 10문항
- 음성 대조 2문항
- `human`·`ai` 모두 존재
- L1~L5 모두 존재
- 원천 참조 누락 0건

질문이나 정답에 현재 그래프의 elementId, 현재 검색 답변 전문, 스크린샷이 들어가면 제거한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/suites/tc-ocr-api-gateway.json` | 신규 — 12문항과 원천 근거 |

## 검증

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/validate-suite.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --data-root apps/pipeline/data
jq '[.questions[] | select(.answerability == "answerable")] | length' eval/suites/tc-ocr-api-gateway.json
jq '[.questions[] | select(.answerability == "insufficient-source")] | length' eval/suites/tc-ocr-api-gateway.json
rg -n "elementId|screenshot|스크린샷" eval/suites/tc-ocr-api-gateway.json
git diff --check
```

두 `jq` 결과는 각각 10과 2여야 한다.
`rg` 결과는 0줄이어야 한다.

## 의도 메모 (왜)

- API Gateway 제거를 고른 이유는 한 결정이 인프라 전환, 설정 변경, 검증, 배포 이력으로 깊게 이어지기 때문이다.
- 업무 전체를 자동 생성하지 않는 이유는 원천을 확인하지 않은 정답이 평가를 오염시키기 때문이다.
- 음성 대조를 남기는 이유는 AI 에이전트가 관계가 없는 기록을 주제 유사성만으로 연결하지 않는지 측정하기 위해서다.

## Blocked 조건

- 표의 업무 원천이 없거나 댓글 id를 확인할 수 없으면
  `PHASE_BLOCKED: 대표 흐름 원천 누락`을 출력하고 추정한 id로 채우지 않는다.
