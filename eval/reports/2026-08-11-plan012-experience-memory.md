# plan012 Experience Memory 수직 검증 — 2026-08-11

## 범위

- 프로젝트: `tc-ocr`
- Git root: `/Users/nhn/projects/OCR`
- raw/memory 산출물: `apps/pipeline/data/` 아래 ignored 파일
- task utility 판정은 하지 않았다. 이 리포트는 원천 수집, 추출 cache, Wiki build, lexical search smoke만 기록한다.

## Source

`apps/pipeline/data/raw/tc-ocr` 부재를 먼저 확인한 뒤 fresh fetch를 실행했다.
이 부재 확인은 세션 시작 시점의 관측이며, raw 생성 뒤에는 durable하게 재검증할 수 없다.

```text
pnpm --filter pipeline fetch-dooray -- --project tc-ocr
결과: task와 Wiki 원천을 fresh fetch로 다시 생성했다.
```

정규화 결과:

- Dooray task, comment, Wiki가 모두 0건보다 많다.
- Git repositories: 9개, canonical unique name 9개, revision 전부 40자 SHA, remote URL 전부 HTTP

실제 raw에는 body가 빈 Dooray task와 Wiki가 있었다.
해당 task/wiki는 stable ID와 title이 있어 title을 최소 evidence text로 사용했다.
comment는 body가 핵심 원천이므로 fallback하지 않는다.

OCR Git 9개 repo는 읽기 전용 명령만 사용했다.
실행 전 snapshot과 종료 시점 재검사를 비교하면 branch, HEAD, remote, tracked status는 9개 모두 동일했다.
전체 `git status --short --branch` 문자열은 OCR.Admin, OCR.Console, cv.ocr.idcard_inf의 untracked `.omc/` runtime 파일 변화 때문에 동일하지 않았다.
따라서 source·tracked worktree 불변은 확인했지만 untracked runtime까지 포함한 exact status 동일 조건은 충족하지 못한 acceptance gap으로 기록한다.

## Extraction

초기 schema v1은 Responses 400으로 실패했다.
안전하게 확인한 오류는 다음과 같다.

```text
type=invalid_request_error
code=invalid_json_schema
```

공식 Structured Outputs 지원 schema 기준에 맞춰 request schema에서 `minLength`와 `uniqueItems`만 제거했다.
근거: `https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas`
빈 문자열과 `sourceRefKeys` 중복은 Zod post-validation으로 유지한다.
prompt/schema identity는 `experience-memory-v2`로 올렸다.

1 packet probe:

- command: `pnpm --filter pipeline extract-memory -- --project tc-ocr --ids <probe-packet-id>`
- result: selected 1, succeeded 1, failed 0, memories 0, calls 1, cacheHits 0

Bounded run:

| run | model | effort | selected | succeeded | failed | memories | calls | cacheHits | complete |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 첫 bounded 실행 | `gpt-5.6-luna` | `low` | 12 | 8 | 4 | 26 | 11 | 1 | false |
| 두 번째 bounded 실행 | `gpt-5.6-luna` | `low` | 12 | 11 | 1 | 34 | 4 | 8 | false |
| 남은 실패 확인 | `gpt-5.6-luna` | `low` | 12 | 12 | 0 | 37 | 1 | 11 | false |
| cache 재실행 | `gpt-5.6-luna` | `low` | 12 | 12 | 0 | 37 | 0 | 12 | false |

첫 bounded run의 cacheHits 1은 위 1 packet probe 때문이다.
두 번째 run은 success-only cache 정책 때문에 성공한 packet 8개만 cache hit였고, 실패 packet 4개는 재호출됐다.
그중 3개는 성공했고 1개는 `Responses 스트림이 오류 이벤트를 반환했다.`로 남았다.
같은 exact bounded command를 한 번 더 실행하자 남은 1개도 성공했고, 최종 재실행은 calls 0과 cacheHits 12를 기록했다.
실패를 content identity에 영구 cache하지 않았다.

## Wiki And Search

```text
pnpm --filter pipeline build-memory-wiki -- --project tc-ocr --allow-incomplete
```

- documents: 37
- complete: false

Search smoke는 모두 `--allow-incomplete`로 실행했다.

| query | searchMs | documentsScanned | returned | 원문 link |
| --- | ---: | ---: | ---: | --- |
| `설계 결정 대안 이유` | 1 | 37 | 1 | sourceRefs URL 존재 확인 |
| `운영 장애 변경 금지 제약` | 1 | 37 | 6 | sourceRefs URL 존재 확인 |
| `실패 migration 교훈` | 1 | 37 | 0 | 결과 0건. lexical 기준선 gap으로 기록한다 |

세 검색 모두 LLM, Neo4j, Postgres를 호출하지 않았다.

## Verification Notes

- `apps/pipeline/data/raw/`와 `apps/pipeline/data/memory/`는 git status에 tracked/untracked 파일로 나타나지 않고 `!! apps/pipeline/data/` ignore로만 보인다.
- OCR Git 9개 repo의 branch, HEAD, remote, tracked status는 실행 전후 동일했다.
  세 repo의 untracked `.omc/` runtime 파일 목록이 바뀌어 전체 status 문자열의 exact 동일 조건은 충족하지 못했다.
- `--sample-per-source 3` 부분 추출이므로 current extraction과 Wiki index는 `complete=false`다.
