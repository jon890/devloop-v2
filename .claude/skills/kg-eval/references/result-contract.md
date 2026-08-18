# kg-eval 결과 계약

이 문서는 `kg-eval`의 세트, 원시 실행 결과, 요약 결과 JSON 형식을 소유한다.
판정 기준은 `docs/EVAL-RUBRIC.md` 섹션 3을 단일 소스로 사용한다.

`kg-eval-suite/v1`은 HTTP 질문 평가 계약이고, `memory-eval-suite/v1`은 Coding Agent Memory 평가 계약이다.
두 suite 형식은 같은 파일명 공간(`eval/suites/`)을 쓰지만 필드와 실행기는 분리한다.

## 평가 세트

평가 세트는 `eval/suites/<flow>.json`에 둔다.
최상위 객체는 다음 필드를 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `schemaVersion` | string | 세트 형식 버전. `kg-eval-suite/v1`만 허용한다 |
| `project` | string | 원천 프로젝트 코드. 예: `tc-ocr` |
| `flowId` | string | 대표 업무 흐름의 안정된 식별자 |
| `title` | string | 사람이 읽는 평가 세트 제목 |
| `sourceSnapshot` | string | gold를 확인한 원천 적재 시점 또는 커밋 설명 |
| `questions` | array | 평가 문항 목록. 최소 12문항 |

각 문항은 다음 필드를 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `id` | string | 세트 안에서 유일한 문항 식별자 |
| `audience` | `human` 또는 `ai` | 질문 표현의 대상 |
| `difficulty` | `L1`부터 `L5` | 난이도 |
| `question` | string | `/api/query`로 보낼 자연어 질문 |
| `answerability` | `answerable` 또는 `insufficient-source` | 원천 근거로 답할 수 있는지 여부 |
| `sourceRefs` | array | 원천 업무·댓글 참조 |
| `graphChecks` | array | 검색 전 그래프에서 확인할 노드·관계 조건 |
| `requiredEvidence` | array | 전부 검색돼야 하는 근거 식별자 |
| `supportingEvidence` | array | 답을 보강하는 근거 식별자 |
| `orderedEvents` | array | 순서가 중요한 근거 식별자 배열 |
| `expectedClaims` | array | 원천이 직접 지지하는 핵심 주장 |
| `forbiddenClaims` | array | 원천에 없는 인과·동일성 주장 |

`sourceRefs` 항목은 안정된 로컬 식별자인 `id`, 원천 종류인 `type`, 원천 업무 번호인 `task`를 가진다.
`type=post`는 `apps/pipeline/data/raw/<project>/posts/<task>.json`의 `post.number`와 일치해야 한다.
`type=comment`는 같은 파일의 `comments[].id`에 존재하는 `commentId`를 추가로 가진다.
`postId`를 선언하면 같은 파일의 `post.id`와도 일치해야 한다.

```json
{
  "id": "task-483",
  "type": "post",
  "task": 483,
  "postId": "3935008503199859816"
}
```

```json
{
  "id": "comment-483-decision",
  "type": "comment",
  "task": 483,
  "commentId": "4053801154616695067"
}
```

`requiredEvidence`, `supportingEvidence`, `orderedEvents`는 `sourceRefs[].id` 문자열 배열이다.
객체 항목이나 별칭 필드는 쓰지 않는다.

`orderedEvents`는 답변에 표시되어야 할 `sourceRefs[].id` 순서다.
`type=post`는 `task` 번호 문자열을, `type=comment`는 `commentId`를 답변 내 검색 문자열로 쓴다.
빈 배열은 순서 검사를 적용하지 않는다는 뜻이다.
하나라도 답변에 없거나 첫 등장 위치가 엄격 증가하지 않으면 `deterministicChecks.order.status=FAIL`이고,
모두 엄격 증가하면 `PASS`다.
그래프와 근거 회수가 먼저 통과한 뒤 순서가 실패하면 `failureBoundary=ANSWER`, `failedAxes=["G"]`로 기록한다.
근거 회수가 먼저 실패하면 순서는 `NOT_EVALUATED`로 기록한다.

`graphChecks` 항목은 검색 전 `/api/graph/samples?label=<Task|Comment>&offset=<n>&limit=100`와 이웃 조회로 확인할 그래프 도달성 조건이다.
`sourceRefs`의 `type=post`는 `Task` 라벨과 `task` 번호 문자열 key를,
`type=comment`는 `Comment` 라벨과 `commentId` 문자열 key를 정확히 비교해 기준 노드를 찾는다.
`/api/graph/search`는 fulltext 검색 전용이라 숫자 업무 번호나 댓글 id 식별자 해석에 사용하지 않는다.
각 항목은 다음 구조를 따른다.

```json
{
  "anchor": "task-483",
  "depth": 2,
  "requiredNodes": ["task-483", "comment-483-decision"],
  "requiredRelationships": [
    {
      "type": "HAS_COMMENT",
      "start": "task-483",
      "end": "comment-483-decision"
    }
  ]
}
```

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `anchor` | string | 이웃 조회를 시작할 `sourceRefs[].id` |
| `depth` | 1..5 정수 | 이웃 조회 깊이 |
| `requiredNodes` | string[] | 그래프에 있어야 하는 `sourceRefs[].id` 목록 |
| `requiredRelationships` | object[] | 그래프에 있어야 하는 관계 목록 |

`requiredRelationships` 항목은 비어 있지 않은 문자열 `type`과 `sourceRefs[].id`를 가리키는 `start`, `end`를 가진다.
`answerability=answerable` 문항은 `graphChecks`를 하나 이상 선언한다.
`answerability=insufficient-source` 문항은 음성 대조이므로 빈 `graphChecks`를 허용한다.

`answerability=answerable` 문항은 `sourceRefs`와 `requiredEvidence`가 비어 있으면 안 된다.
`answerability=insufficient-source` 문항은 `requiredEvidence`를 비워 두고 `forbiddenClaims`를 하나 이상 선언한다.

## 원시 실행 결과

원시 실행 결과는 `eval/runs/` 아래에 두고 커밋하지 않는다.
최상위 객체는 실행 조건과 `attempts` 배열을 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `schemaVersion` | string | 원시 실행 결과 형식 버전. 예: `kg-eval-run/v1` |
| `suitePath` | string | 실행한 평가 세트 경로 |
| `suiteHash` | string | 실행한 평가 세트 내용 해시 |
| `commit` | string | 대상 커밋 |
| `stage` | string | 평가 단계 이름 |
| `baseUrl` | string | API 기준 URL |
| `declaredQueryModel` | string | 호출자가 선언한 질의 모델 표기 |
| `repetitions` | number | 문항별 반복 횟수. 기본 3 |
| `startedAt` | string | 실행 시작 시각 |
| `attempts` | array | 문항·회차별 원시 응답 |

`attempts` 항목은 다음 값을 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `questionId` | string | 문항 id |
| `attempt` | number | 1부터 시작하는 회차 |
| `startedAt` | string | 회차 시작 시각 |
| `latencyMs` | number | HTTP 왕복 시간 |
| `httpStatus` | number | HTTP 상태 |
| `answer` | string | API 원본 답변 |
| `evidence` | object | API 원본 근거. `packages/shared/src/api/api.schema.ts`의 `EvidenceSchema`와 같은 `{ "nodes": [], "relationships": [] }` 구조 |
| `cypher` | string 또는 null | API가 반환한 Cypher |
| `error` | string 또는 null | 실패 시 오류 메시지 |

## 요약 결과

요약 결과는 `eval/reports/`에 JSON과 Markdown으로 함께 둔다.
최상위 객체는 실행 조건, 기준선 비교 정보, `questions` 배열을 가진다.
세트 내용 해시는 report 형식에서는 `suite.hash`에 둔다.
비교기는 raw 실행 결과의 top-level `suiteHash`와 report의 `suite.hash`를 모두 읽지만,
둘 다 있으면 같은 비어 있지 않은 값이어야 한다.

각 `questions` 항목은 다음 값을 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `id` | string | 문항 id |
| `audience` | `human` 또는 `ai` | 질문 표현의 대상 |
| `difficulty` | `L1`부터 `L5` | 난이도 |
| `answerability` | `answerable` 또는 `insufficient-source` | 원천 근거로 답할 수 있는지 여부 |
| `deterministicChecks` | object | HTTP, 근거 id, 필수 근거, 순서 등 결정적 검사 |
| `semanticJudgments` | array | 두 독립 의미 판정 |
| `stability` | object | 3회 반복의 축별 일치 여부 |
| `finalVerdict` | `PASS`, `FAIL`, `REVIEW` | 최종 판정 |
| `failureBoundary` | `SOURCE`, `GRAPH`, `RETRIEVAL`, `ANSWER`, `NONE`, `NOT_EVALUATED` | 실패 경계 |
| `failedAxes` | array | 실패한 A/R/P/G 축. U는 경고만 기록 |
| `notes` | array | 사람이 확인할 메모 |

`finalVerdict=REVIEW`는 반복 결과가 흔들리거나 두 의미 판정이 불일치할 때 사용한다.
`failureBoundary`는 앞 경계가 실패하면 뒤 경계를 `NOT_EVALUATED`로 둔다는 원칙을 따른다.

## 비교 결과

`compare.mjs`는 **문항 id 교집합**으로 비교한다. 세트가 자라도 비교선이 끊기지 않게 하기 위해서다.
세트 해시가 다르다고 거부하지 않고 `suiteChanged`로 표시한다.

| 필드 | 의미 |
| --- | --- |
| `baselineSuiteHash`·`candidateSuiteHash`·`suiteChanged` | 두 세트가 같은 내용인지 |
| `added`·`removed` | 한쪽에만 있는 문항. 조용히 빠지지 않게 나열한다 |
| `criteriaChanged` | 같은 문항인데 gold 규모가 달라졌다. **개선·회귀로 세지 않는다** |
| `improved`·`regressed`·`unchanged`·`review` | `finalVerdict` 등급 비교 |
| `axisChanges` | 실패 경계 변화와 독립적으로 문항별 `failedAxes`의 추가·해소 |
| `failureBoundaryChanges` | 실패 경계가 달라진 문항만 |

`criteriaChanged` 판정은 `requiredEvidenceCount`·`supportingEvidenceCount` 비교다.
**문항이 추가된 것과 기존 문항의 정답이 바뀐 것은 다르게 다뤄야 한다** — 앞은 비교 가능하고 뒤는 아니다.

의미 판정을 하지 않은 측정에서는 `improved`·`regressed`·`unchanged` 버킷을 근거로 쓰지 마라.
그 버킷은 `finalVerdict` 등급 비교이고, 판정하지 않은 문항은 `REVIEW`로 두기 때문이다.
그럴 때 의미 있는 근거는 `failureBoundaryChanges`와 `axisChanges`뿐이다.

## Memory 평가 공개 세트

Memory 평가 공개 세트는 `schemaVersion=memory-eval-suite/v1`을 사용한다.
커밋 가능한 파일이며 내부 URL, 절대 repository path, Git revision, prompt, oracle query를 담지 않는다.

최상위 객체는 다음 필드를 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `schemaVersion` | string | `memory-eval-suite/v1`만 허용한다 |
| `project` | string | 대상 프로젝트 코드 |
| `suiteId` | string | private source lock과 맞출 안정 식별자 |
| `title` | string | 사람이 읽는 제목 |
| `sourceSnapshot` | string | 공개 가능한 snapshot 설명. private 값은 쓰지 않는다 |
| `tasks` | array | 공개 task metadata 목록 |

각 `tasks` 항목은 다음 값을 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `id` | string | suite 안에서 유일한 task 식별자 |
| `category` | `code-only` 또는 `experience-needed` | Memory 필요 여부 분류 |
| `taskType` | string | 작업 유형 |
| `sourceLockKey` | string | private source lock 항목을 가리키는 공개 key |
| `expectedTrigger` | string | 기대되는 실행 trigger 분류 |
| `tags` | string[] | 선택적 분류 태그. `relationship-heavy`를 사용할 수 있다 |

검증기는 `id`와 `sourceLockKey`의 중복을 거부하고, `code-only`와 `experience-needed`가 각각 두 개 이상이며
`relationship-heavy` task가 하나 이상인지 확인한다.

## Memory private source lock

Private source lock은 커밋하지 않는다.
공개 suite의 `tasks[].id`와 `tasks[].sourceLockKey`에 전단사로 대응해야 한다.

최상위 객체는 다음 필드를 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `schemaVersion` | string | `memory-source-lock/v1`만 허용한다 |
| `suiteId` | string | 공개 suite의 `suiteId`와 같아야 한다 |
| `sourceSnapshot` | string | private source snapshot 설명 |
| `tasks` | array | task별 private source lock |

각 task lock은 다음 값을 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `taskId` | string | 공개 suite의 `tasks[].id` |
| `sourceLockKey` | string | 공개 suite의 `tasks[].sourceLockKey` |
| `repositoryPath` | string | 고정 revision을 제공하는 private 실행 저장소의 절대 경로 |
| `sourceUrl` | string | 내부 원천 URL |
| `baseRevision` | 40자 hex string | `git archive`로 읽을 기준 revision |
| `targetRevision` | 40자 hex string | oracle 비교용 목표 revision |
| `prompt` | string | Agent에게 줄 private task prompt |
| `allowedPaths` | string[] | 변경 허용 repository 상대 경로 |
| `validationCommand` | string[] | 평가 workspace에서 실행할 검증 명령 |
| `oracleQuery` | string | 판정자가 사용할 private oracle query |

Memory workspace 생성기는 private 실행 저장소에서 `git archive <baseRevision>`만 실행한다.
private 실행 저장소에서 checkout, fetch, reset, clean, worktree 명령을 실행하지 않는다.
archive 결과는 `eval/runs/workspaces/<run-key>/`에 풀고, 그 디렉터리에서 새 로컬 Git 저장소를 만든다.

## Memory 원시 실행 결과

Memory 원시 실행 결과는 `schemaVersion=memory-eval-run/v1`을 사용하고 `eval/runs/` 아래에 둔다.
커밋하지 않는다.

최상위 객체는 다음 필드를 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `suitePath` | string | 공개 suite 경로 |
| `sourceLockPath` | string | private source lock 경로 |
| `suiteHash` | string | 공개 suite canonical hash |
| `sourceLockHash` | string | private source lock canonical hash |
| `taskInputs` | array | task별 실행 입력 lock. `taskId` 기준 정렬 |
| `memoryIndexHash` | string | 사용한 Memory index hash |
| `sourceRepositoryRoot` | string? | opt-in source repository root real path. 있으면 raw run resume 비교 조건에 포함 |
| `resolvedRepositories` | array? | opt-in source repository root로 검증한 task별 실행 repository resolution |
| `graphLockPath` | string? | `memory-graph` 조건에서 사용한 private Graph lock 경로 |
| `graphLockHash` | string? | `memory-graph` 조건에서 사용한 Graph lock byte hash |
| `graphBaseUrl` | string? | `memory-graph` 조건에서 사용한 Graph API base URL |
| `agent` | string | 실행한 Agent 종류. 예: `codex`, `claude` |
| `agentOptions` | object | run-level Agent 옵션 lock. `model`, `effort`, `permissionMode`의 누락 값은 `null`로 정규화 |
| `attempts` | array | task·condition·repetition별 결과 |

`taskInputs` 항목은 `{ "taskId": string, "baseRevision": string, "validationCommand": string[] }` 형식이다.
runner는 `taskId` 기준 canonical order로 저장하고 비교한다.

`attempts`의 유일 키는 `(taskId, condition, repetition)`이다.
이어 쓰기는 `suiteHash`, `sourceLockHash`, `taskInputs`, `memoryIndexHash`, `agent`, `agentOptions`가 모두 같을 때만 허용한다.
task 순서만 바뀐 입력은 같은 조건으로 보지만, task 하나의 `baseRevision` 또는 `validationCommand`가 바뀌면 다른 실행으로 거부한다.
`agentOptions` 비교는 `model`, `effort`, `permissionMode`만 사용하며 각 값이 없으면 `null`로 비교한다.
기존 결과 파일에 run-level `agent` 또는 `agentOptions`가 없으면 다른 실행 조건으로 보고 resume을 거부한다.
`memory-graph` 조건은 `graphLockPath`, `graphLockHash`, `graphBaseUrl`도 resume 비교 조건으로 사용한다.
저장은 임시 JSON 파일을 파싱해 검증한 뒤 rename한다.
동시에 같은 결과 파일을 쓰려 하면 `<out>.lock` 충돌로 실패해야 한다.

판정기는 저장 계층이나 Agent process를 직접 호출하지 않는다.
validation 결과, 허용 경로 밖 변경, 최종 diff와 실행 event를 입력으로 받아 `taskSuccess`, `wrongEditCount`, `reworkCount`를 계산한다.

`memory-graph` attempt는 다음 flat field를 추가로 가진다.

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `graphContextCalls` | number | Agent 실행 전 deterministic Graph context adapter HTTP call 수 |
| `agentGraphCalls` | number | Agent event에서 관측된 직접 Graph command 수 |
| `graphCalls` | number | `graphContextCalls + agentGraphCalls` |
| `graphLlmCalls` | number | Graph LLM call 수. deterministic adapter 조건에서는 항상 0 |
| `graphLatencyMs` | number | Graph context adapter HTTP call 총 latency |
| `graphEvidenceUsed` | boolean 또는 null | 제공한 source key나 relationship이 Agent event text에 관측됐는지 여부. 관측 근거가 없으면 null |
