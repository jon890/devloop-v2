# 함정 — 테스트

**테스트를 추가하거나 통과를 근거로 삼기 전에 읽는다.**

## 통과 표시가 아니라 테스트 개수를 확인하라

`pnpm --filter api test` 는 `test` 스크립트가 없으면 **exit 0 으로 조용히 통과**한다.
아무 테스트도 돌지 않았는데 성공으로 보인다. 실제로 머지 직전에 이것에 걸렸다.

- **현재 개수 — api 73, pipeline 163** (2026-08-04 실측). 줄었으면 무언가 실행되지 않는 것이다
- `api` 는 `test` 가 `test:unit` 을 부르도록 고쳐졌다. 다만 개수 확인 습관은 유지한다

## 새 테스트 파일은 목록에 넣어야 실행된다

`apps/pipeline/package.json` 의 test glob 이 경로를 열거하는 방식이라 새 디렉터리의 테스트는
자동으로 잡히지 않는다. `api` 의 `test:unit` 은 **파일을 하나씩 열거**하므로 더 잘 빠진다.

- **하지 말 것**: 테스트 파일만 만들고 통과했다고 믿기
- **대신 할 것**: `package.json` 목록을 함께 갱신하고 **개수가 늘었는지** 확인한다
- plan006 에서 `dist/parse/*.test.js` 와 `dist/*.test.js` 를 추가했다 (dist 루트 테스트가 어느
  glob 에도 안 걸려 있었다)

## pipeline 테스트 5건은 조건부로 건너뛴다

`curation.test.ts` 가 테스트 Postgres(15435)와 `REGISTRY_DATABASE_URL` 이 없으면 건너뛴다.
그냥 돌리면 158 통과·5 건너뜀이 나오는데 **초록으로 보이므로 알아채기 어렵다.**

판단 저장소를 손댔으면 아래로 확인한다.

```bash
# cwd: 저장소 루트
docker compose --profile test up -d postgres-test
REGISTRY_DATABASE_URL=postgresql://devloop:devloop-test-password@localhost:15435/devloop_registry \
  pnpm --filter pipeline test
```

`skipped 0` 이어야 한다. 건너뜀이 남으면 그 5건은 검증되지 않은 것이다.

## 가드를 추가하면 변이로 검증하라

리뷰어가 denylist 조건을 무력화해도 32건 전부 통과하는 것을 발견했다.
**테스트가 있다는 것과 그 테스트가 무언가를 보호한다는 것은 다르다.**

- **대신 할 것**: 가드 로직을 **의도적으로 깨뜨려** 테스트가 실제로 실패하는지 확인하고 원복한다
- 실측 사례 — plan007 에서 예산 가드·우선순위 규칙·프롬프트 지시를 각각 되돌려 매번 검출되는 것을 확인했다

## 프롬프트 지시도 테스트로 고정하라

이 저장소의 Cypher 생성 프롬프트는 오랫동안 **어느 테스트도 문구를 검증하지 않았다.**
지시가 조용히 사라져도 아무것도 안 잡는다.

- **대신 할 것**: `llmCli` 를 대역으로 넣어 프롬프트를 포착하고 핵심 문구를 단정한다
  (`apps/api/test/cypher-prompt.test.js`)

## e2e 는 오래 깨져 있었고 아무도 몰랐다

`apps/api/test/fixtures/graph/e2e/` 의 fixture 가 Concept 을 `nodes.jsonl` 에 담고 있었다.
`sync-neo4j` 의 `conceptSource` 는 `parsed.jsonl`·`inferred.jsonl` 만 허용하므로 예외로 죽는다.

- 발견되지 않은 이유는 **7688 포트 충돌로 컨테이너 기동에서 먼저 막혀** 예외까지 도달조차 못 했기 때문이다
- 즉 **"실행이 실패했다" 와 "테스트가 실패했다" 가 구분되지 않으면 결함이 무한히 숨는다**
- fixture 는 이제 실제 파이프라인 형상과 같다 — `parsed.jsonl` 에 구조 노드, `inferred.jsonl` 에 Concept·Decision
- e2e 를 손댔으면 **적재 단계만 따로 실행해** 확인한다. 이 예외는 DB 접속 전에 나므로 Neo4j 없이 재현된다

  ```bash
  pnpm --filter pipeline sync-neo4j --project e2e --data-dir <절대경로>/apps/api/test/fixtures
  ```

## 정적 기준이 스스로를 검증하지 않게 하라

S2 판정식을 적재기 정규화 함수와 같게 만들면 적재기가 보장하는 것을 재확인할 뿐이라 감시 기능을 잃는다.
그래서 두 축으로 나눴다.

- S2a — 적재기 회귀 감시 (통과 보장이 정상)
- S2b — 새 유형 탐지 (오탐이 섞이므로 측정·기록만)

## 우리 로직을 검증하라

Postgres 가 DDL 대로 막는 것(check·FK·cascade)을 자동 테스트로 재확인하지 않는다.
DB 가 필요해 **기본 실행에서 건너뛰는** 테스트를 늘리면 보호가 필요한 순간에 아무것도 막지 못한다.
