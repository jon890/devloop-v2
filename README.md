# devloop-v2 — Dooray 지식그래프 AI Agents MVP

Dooray 프로젝트(기본 tc-ocr)의 업무·위키를 수집해 고정 온톨로지 기반 지식그래프(Neo4j)로 적재하고,
자연어 관계형 질문에 근거 서브그래프 시각화와 함께 답하는 MVP.

> **주의**: 이 저장소는 **사내 GHE 전용**이다. 공개 GitHub 등 외부로 push 하지 않는다.
> `data/` 아래 사내 원문 데이터는 gitignore 로 커밋에서 제외된다.

## 문서

- `docs/SPEC.md` — 확정 요구사항·인수 기준
- `docs/PLAN.md` — 구현 계획 (phase·병렬 작업 패키지·공유 계약)
- `docs/EVAL-RUBRIC.md` — 품질 기준 단일 소스 (온톨로지 정적 기준·채점표·통과선)
- `docs/QUESTIONS.md` — 평가 질문 해설
- `eval/` — gold 질문 은행·정적 점검 쿼리·평가 리포트
- `.claude/skills/` — 평가 스킬 3종 (kg-eval-human, kg-eval-ai, kg-model-bench)
