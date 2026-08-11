# Phase 04 — 최신 실제 원천으로 수직 경로를 검증하고 plan을 닫는다

**Execution profile**: standard
**Status**: pending

---

## 목표

최신 Dooray raw와 OCR Git의 pinned revision으로 세 원천 수직 경로를 실행한다.
token 예산을 지키는 bounded Luna 파일럿으로 cache·Wiki·검색을 검증하고, 기존 관리 문서와 plan 상태를 실제 결과에 맞춰 닫는다.

**범위 외**

- 전체 GraphRAG 재추출과 Neo4j 변경
- 검증 없이 전체 evidence를 Luna로 일괄 추출
- automatic retrieval과 vector 검색 구현
- `docs/memory/` 또는 별도 계획·제안 문서

---

## 작업 항목 (4)

### 1. Dooray 원문을 최신화하고 세 원천 manifest를 만든다

기존 `fetch-dooray`로 `tc-ocr` raw를 다시 받은 뒤 `normalize-memory`를 실행한다.
Git root는 `/Users/nhn/projects/OCR`로 고정한다.

manifest에서 Dooray task·comment·Wiki 건수가 0보다 크고 Git 저장소 9개의 서로 다른 이름·40자 revision·HTTP remote URL이 있는지 검사한다.
원천 저장소 9개의 작업 tree 상태가 실행 전후 동일한지 비교한다.

### 2. bounded Luna 파일럿과 cache 재실행을 검증한다

원천 종류와 kind 후보가 섞이도록 evidence ID를 결정적으로 선택해 최대 12 packet만 추출한다.
첫 실행의 model, effort, calls, failures를 기록하고 같은 명령을 다시 실행해 두 번째 calls가 0인지 확인한다.

부분 추출이므로 report와 index는 `complete: false`여야 한다.
파일럿 build와 search에서만 `--allow-incomplete`를 명시한다.
실패가 있으면 다른 모델로 재시도하지 말고 원인과 사용하지 않은 packet 수를 기록한다.

### 3. Coding Agent용 검색 smoke와 비용 지표를 측정한다

결정 이유, 변경 금지 제약, 과거 장애 또는 실패 시도에 해당하는 query를 최소 3개 실행한다.

- 결과 relevance와 원문 link 유효성
- `searchMs`, `documentsScanned`, `returned`
- Memory 호출 수와 추가 source read 수
- 현재 source에서 재구성 가능한 사실이 상위 결과를 오염시키는지

단위가 다른 Retrieval Tax와 Memory Benefit을 하나의 점수로 임의 합산하지 않는다.
실제 관측 가능한 값만 `eval/reports/2026-08-XX-plan012-experience-memory.md`에 남기고 token을 문자 수로 추정하지 않는다.

### 4. 기존 관리 문서와 task 상태를 닫는다

실제 구현과 명령에 맞춰 `README.md`, `CLAUDE.md`, `docs/prd.md`, `docs/flow.md`, `docs/code-architecture.md`, `docs/data-schema.md`만 필요한 만큼 갱신한다.
추가 설계 문서군을 만들지 않는다.

`docs/retrospectives/RUNS.md` 끝에 build-with-teams 실행 기록 한 줄을 추가한다.
`tasks/plan012-experience-memory/index.json`의 status와 네 phase status를 `completed`로 바꾸고 각 phase 머리의 `**Status**`도 맞춘다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/data/raw/tc-ocr/` | 최신화 — gitignore, 커밋 금지 |
| `apps/pipeline/data/memory/tc-ocr/` | 생성 — gitignore, 커밋 금지 |
| `eval/reports/2026-08-XX-plan012-experience-memory.md` | 신규 — 실제 파일럿과 검색 근거 |
| `README.md` | 수정 — 검증된 명령과 상태 |
| `CLAUDE.md` | 수정 — 구현 구조와 운영 제약 |
| `docs/retrospectives/RUNS.md` | 수정 — 실행 결과 한 줄 |
| `tasks/plan012-experience-memory/index.json` | 수정 — 완료 상태 |

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter pipeline fetch-dooray -- --project tc-ocr
pnpm --filter pipeline normalize-memory -- --project tc-ocr --git-root /Users/nhn/projects/OCR
pnpm --filter pipeline extract-memory -- --project tc-ocr --limit 12
pnpm --filter pipeline extract-memory -- --project tc-ocr --limit 12
pnpm --filter pipeline build-memory-wiki -- --project tc-ocr --allow-incomplete
pnpm --filter pipeline memory-search -- --project tc-ocr --query "과거 장애 때문에 바꾸면 안 되는 설정" --allow-incomplete
pnpm --filter pipeline test
pnpm -r build
pnpm format:check
git diff --check
```

두 번째 추출 report의 calls가 0이고 cache hit가 선택 packet 수와 같은지 확인한다.
`git status --short`에 `apps/pipeline/data/raw/`와 `apps/pipeline/data/memory/` 파일이 나타나지 않는지 확인한다.
OCR 저장소 9개의 branch·HEAD·status가 실행 전후 같아야 한다.

## 의도 메모 (왜)

- raw를 먼저 갱신해야 stale snapshot으로 새 구조의 효용을 판정하지 않는다.
- 전체 추출 전 bounded 파일럿으로 모델·cache·provenance를 검증해 token 예산을 보호한다.
- incomplete를 숨기지 않으면 파일럿 결과가 완성된 지식 저장소로 오해되지 않는다.
