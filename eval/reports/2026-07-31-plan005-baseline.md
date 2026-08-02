# Plan005 kg-eval 기준선 리포트

## 실행 조건

- 원시 실행: `eval/runs/plan005-baseline.json`
- 평가 세트: `eval/suites/tc-ocr-api-gateway.json`
- 세트 해시: `141153e4727dfa2d3dfcc17d053e340f7a3b2738624af2f2f27fc934d3a4485d`
- 대상 커밋: `5749ac13db79266097062476308569d13475e3c7`
- stage: `plan005-baseline`
- API 기준 URL: `http://localhost:3000`
- 선언한 질의 모델: `gpt-5.6-terra`
- 모델 한계: 이 값은 `.env` 선언과 실행 명령의 표기이며, API 응답이 실제 런타임 모델 id를 증명하지는 않는다.
- 완료: 36/36 attempts
- HTTP 상태: 201 36
- 오류: 0

## 사전 실행 교훈

첫 완료 raw run은 `eval/runs/plan005-baseline-preflight-failure.json`로 보존했다.
그 실행은 36 attempts 중 30건이 `GRAPH` 실패였고, 숫자 업무 번호와 댓글 id를 fulltext 검색으로 해석한 preflight 경로가 원인이었다.
통합 수정 뒤 새 실행은 `GRAPH` 실패가 0건이다.

## 집계

| 항목 | PASS | FAIL | REVIEW |
| --- | ---: | ---: | ---: |
| Attempt | 1 | 13 | 22 |
| Question | 0 | 2 | 10 |

| 경계 | 건수 |
| --- | ---: |
| ANSWER | 2 |
| NONE | 15 |
| RETRIEVAL | 19 |

| 의미 판정 | 건수 |
| --- | ---: |
| AGREE | 14 |
| DISAGREE | 22 |

## 분포

| Audience | 질문 수 | PASS | FAIL | REVIEW |
| --- | ---: | ---: | ---: | ---: |
| human | 6 | 0 | 2 | 4 |
| ai | 6 | 0 | 0 | 6 |

| Difficulty | 질문 수 | PASS | FAIL | REVIEW |
| --- | ---: | ---: | ---: | ---: |
| L1 | 2 | 0 | 0 | 2 |
| L2 | 3 | 0 | 1 | 2 |
| L3 | 3 | 0 | 1 | 2 |
| L4 | 2 | 0 | 0 | 2 |
| L5 | 2 | 0 | 0 | 2 |

## 문항별 결과

| ID | audience | difficulty | answerability | deterministic boundary | semantic agreement | stability | final | axes |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| AGW-H01 | human | L4 | answerable | NONE 1, RETRIEVAL 2 | 3/3 | unstable | REVIEW | R |
| AGW-H02 | human | L2 | answerable | NONE 2, RETRIEVAL 1 | 0/3 | unstable | REVIEW | R |
| AGW-H03 | human | L3 | answerable | RETRIEVAL 3 | 3/3 | stable | FAIL | R |
| AGW-H04 | human | L2 | answerable | RETRIEVAL 3 | 3/3 | stable | FAIL | R |
| AGW-H05 | human | L4 | answerable | ANSWER 2, NONE 1 | 0/3 | unstable | REVIEW | G |
| AGW-A01 | ai | L3 | answerable | RETRIEVAL 3 | 0/3 | unstable | REVIEW | R |
| AGW-A02 | ai | L3 | answerable | NONE 1, RETRIEVAL 2 | 0/3 | unstable | REVIEW | R |
| AGW-A03 | ai | L2 | answerable | NONE 3 | 2/3 | unstable | REVIEW | - |
| AGW-A04 | ai | L5 | answerable | NONE 1, RETRIEVAL 2 | 3/3 | unstable | REVIEW | R |
| AGW-A05 | ai | L5 | answerable | RETRIEVAL 3 | 0/3 | unstable | REVIEW | R |
| AGW-N01 | human | L1 | insufficient-source | NONE 3 | 0/3 | unstable | REVIEW | - |
| AGW-N02 | ai | L1 | insufficient-source | NONE 3 | 0/3 | unstable | REVIEW | - |

## 음성 대조

| ID | audience | difficulty | final | forbidden-claim violations |
| --- | --- | --- | --- | --- |
| AGW-N01 | human | L1 | REVIEW | 2:A[2]/B[2] |
| AGW-N02 | ai | L1 | REVIEW | 2:A[0,1]/B[0,1,2] |

음성 대조 문항은 의미 판정만으로 판단했고, 금지 주장 위반 인덱스가 있는 회차를 노출했다.

## 다음 개선 경계

다음 한 가지 개선 경계는 `RETRIEVAL`이다.
근거는 36 attempts 중 19건이 필수 근거 회수 실패로 멈췄고, `GRAPH` 실패는 0건이며, `ANSWER` 실패는 2건이라는 분포다.

## 판정 규칙

Grader A의 `SATISFIED`, `CLEAN`, `ACCURATE`, `CAUTIOUS`는 `PASS`로 정규화했다.
`MISSING`, `VIOLATED`, `PARTIAL`, `INCOMPLETE`, `INACCURATE`, `OVERSTATED`는 `FAIL`로 정규화했다.
Grader B는 원래의 `PASS`, `FAIL`, `REVIEW` 값을 사용했다.

두 채점자의 정규화된 `expectedClaimsStatus`, `forbiddenClaimsStatus`, `causalOrderStatus`, `verdict`, `missingClaimIndexes`, `violatedClaimIndexes` 중 하나라도 다르면 해당 attempt의 의미 판정과 최종 판정을 `REVIEW`로 두었다.
결정적 `GRAPH`, `RETRIEVAL`, `ANSWER` 실패는 그대로 기록했고, answerable attempt는 그 상태에서 `PASS`가 될 수 없게 했다.
질문 단위는 3회 반복의 boundary/axes와 최종 판정이 모두 같을 때만 안정으로 두었다.
