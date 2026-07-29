# devloop-v2 — Dooray 지식그래프 AI Agents MVP

Dooray 프로젝트(기본 tc-ocr)의 업무·위키를 수집해 고정 온톨로지 기반 지식그래프(Neo4j)로 적재하고,
자연어 관계형 질문에 근거 서브그래프 시각화와 함께 답하는 MVP.

> **주의**: 이 저장소는 **사내 GHE 전용**이다. 공개 GitHub 등 외부로 push 하지 않는다.
> `data/` 아래 사내 원문 데이터는 gitignore 로 커밋에서 제외된다.

## 문서

- `docs/SPEC.md` — 확정 요구사항·인수 기준
- `docs/PLAN.md` — 구현 계획 (phase·병렬 작업 패키지·공유 계약)
- `docs/EVAL-RUBRIC.md` — 품질 기준 단일 소스 (온톨로지 정적 기준·채점표·통과선)
- `eval/questions-{human,ai}-<project>.json` — 평가 질문 gold 단일 소스 (기대 근거 포함)
- `eval/` — 정적 점검 쿼리·평가 리포트
- `.claude/skills/` — 평가 스킬 3종 (kg-eval-human, kg-eval-ai, kg-model-bench)

## 실행

먼저 환경 파일을 준비하고 Neo4j를 실행한다.

```bash
cp .env.example .env
docker compose up -d neo4j
```

파이프라인은 Dooray 원문 수집부터 구조·개념 추출과 Neo4j 적재까지 실행한다.

```bash
pnpm pipeline -- --project tc-ocr
```

API와 웹은 각각 별도 터미널에서 실행한다.

```bash
pnpm -r build
pnpm api
```

```bash
pnpm web
```

기본 접속 주소는 API `http://localhost:3000`, 웹 `http://localhost:5173`이다.
API e2e는 `pnpm --filter api test:e2e`로 실행하며, 테스트 전용 Neo4j `bolt://localhost:7688`을 자동으로 기동하고 종료한다.
이 테스트는 운영 개발 DB 포트 `7687`을 거부한다.

## 그래프 초기화

적재기(`sync-neo4j`)는 MERGE 전용이라 노드가 자동으로 줄지 않는다.
정규화를 고쳐 노드가 합쳐지게 만들었어도, 그래프를 비우고 다시 적재해야 병합 효과가 보인다.

`NEO4J_URI`는 인라인으로 주면 첫 줄에만 걸린다. `apply-schema`·`sync-neo4j`는 기본값
`bolt://localhost:7687`로 붙으므로, 세 명령 모두에 같은 URI가 걸리도록 `export`로 셸에 남겨야 한다.

```bash
export NEO4J_URI=bolt://localhost:7690
pnpm --filter pipeline reset-neo4j --force
pnpm apply-schema
pnpm --filter pipeline sync-neo4j
```

`reset-neo4j`는 `NEO4J_URI`가 없으면 실행하지 않는다 — 삭제 대상을 항상 명시하게 만든다.
`--force` 없이도 실행을 거부하고, 대상 포트가 운영(`7687`)이면 `--allow-production`을 함께 줘야 한다.
산출물 `jsonl`이 `data/graph/`에 남아 있으므로 초기화 후 재적재로 항상 복원된다.

## 모델 구성

- `LLM_MODEL=gpt-5.5`: 파이프라인 추출 모델. API는 이 값을 읽지 않는다
- `QUERY_LLM_MODEL=gpt-5.6-terra`: API 자연어 질의 모델
- `QUERY_LLM_MODEL`이 없으면 API는 `LLM_MODEL`로 대체하지 않고 기동에 실패한다.
  값이 없을 때 조용히 다른 모델로 질의가 도는 것을 막기 위해서다.
