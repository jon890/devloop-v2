# 함정 — 프로세스·컨테이너·워크트리

**컨테이너나 워크트리를 만들거나 지우기 전에 읽는다.**

## `docker compose down` 을 쓰지 마라

`down` 은 **프로필과 무관하게 compose 프로젝트 전체를 제거한다.** 실제로
`docker compose --profile test down` 으로 **운영 Neo4j 컨테이너가 지워졌다.**
볼륨이 남아 재기동으로 복구했지만 `-v` 가 붙었으면 데이터를 잃었다.

- **대신 할 것**: 서비스 이름을 명시하는 `docker compose rm -sf <서비스>` 만 쓴다.
  지울 대상을 손으로 적게 만드는 것이 요점이다
- **다른 워크트리에서 띄운 컨테이너는 compose 프로젝트가 다르다.** 저장소 루트에서
  `docker compose` 로 지워지지 않는다. `docker rm -f <이름>` 으로 직접 지운다

같은 사고로 워크트리 Postgres 를 지워 **판단 데이터가 사라진 적도 있다.**
`export-curation` 보관본으로 바이트 동등하게 복구했다 — 판단 저장소를 손대기 전에 덤프를 뜬다.

## 작업이 끝나면 띄운 것을 정리하라

검증용으로 띄운 컨테이너·프로세스를 남겨 두면 **다음에 무엇이 살아 있는지 헷갈린다.**
어느 인스턴스에 붙었는지 모르는 상태가 이 저장소에서 사고로 이어졌다.

```bash
# cwd: 저장소 루트
docker compose rm -sf neo4j-test postgres-test     # 테스트 컨테이너만 지운다
docker ps --format '{{.Names}} {{.Ports}}'         # 남은 것 확인
lsof -nP -iTCP:3000 -iTCP:5173 -sTCP:LISTEN        # dev 서버 확인
```

- **테스트 인스턴스는 제거한다.** `Exited` 로 남기면 "정리했다" 와 구분되지 않는다
- **개발 인스턴스(Neo4j 7687·Postgres 15434)는 유지한다.** 운영 데이터가 들어 있다
- **코드를 바꿨으면 dev 서버(API 3000·web 5173)를 재시작한다.** 낡은 프로세스가 새 계약을
  만족하지 못해 화면이 비는 사고가 실제로 났다
- 정리 후 무엇을 남겼고 무엇을 지웠는지 보고에 적는다

## 워크트리는 저장소 안 `worktrees/` 에 만들어라

`~/.gitconfig` 의 조건부 규칙이 `~/personal/` 경로에만 개인 계정을 적용한다.
그 밖에서 만든 체크아웃은 **직전에 활성이던 계정이 그대로 박힌다** — 실제로 공개 저장소 첫 커밋에
사내 이메일이 들어가 GitHub 이 사내 계정으로 표시한 사고가 있었다.

저장소 안에 두면 경로가 항상 `~/personal/` 아래이므로 규칙에서 벗어날 수 없다.
`worktrees/` 는 gitignore 대상이다 — 무시하지 않으면 `git status` 가 untracked 로 보고 커밋에 휩쓸린다.

`orca worktree create` 는 경로를 지정할 수 없다. 그래서 두 단계로 만든다.

```bash
# cwd: 저장소 루트
git worktree add worktrees/<slug> -b <branch> <base-branch>
orca terminal create --worktree "path:$(pwd)/worktrees/<slug>" --command "codex"
```

- **`.env` 와 `apps/pipeline/data` 를 복사하고 `pnpm install` 을 한 뒤** 에이전트를 띄운다.
  둘 다 gitignore 대상이라 복제되지 않고, 없으면 phase 가 `PHASE_BLOCKED` 로 멈춘다
- 커밋 전에 `git config user.email` 이 개인 주소인지 확인한다

## `git add -A` 로 무관한 파일을 담지 마라

`docs/prompts/`·`docs/research/` 의 추적되지 않던 문서 2,538줄이 문서 커밋에 섞였다.
독립 검토가 원자적 커밋 규칙 위반으로 잡았다.

- **대신 할 것**: 관심사에 해당하는 경로만 `git add <경로>` 로 담는다
- 되돌릴 때 `git rm --cached` 는 작업 트리 파일을 남기지만, **지운 뒤 파일이 사라진 사례가 있었다.**
  되돌리기 전에 백업하고 복구 후 바이트 동등을 확인한다

## 커밋은 관심사 단위로 나눈다

한 작업에서 성격이 다른 변경이 함께 생기면 각각 별도 커밋으로 분리한다.
"여기까지 커밋" 이라는 지시가 있어도 자동으로 한 커밋에 합치지 않는다.

## 포맷터를 파일 전체에 돌리지 마라

codex 가 적재기를 재포맷해 316줄 diff 가 되어 **기능 변경 93줄이 묻혔다.** 원복 후에야 검토가 가능해졌다.

- **대신 할 것**: 손댄 줄만 바꾼다. 포맷 통일은 **기능 변경과 분리된 독립 커밋**으로 만든다
- prettier 설정은 더블 쿼트·세미콜론·`printWidth: 150` 이다
