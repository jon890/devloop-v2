# 프로젝트 작업 규칙

## Experience Memory 소스

- 지식 저장소는 Dooray 업무와 댓글, Dooray Wiki, `/Users/nhn/projects/OCR` 아래의 모든 Git 저장소를 원천으로 사용한다.
- Git 원천 저장소는 읽기 전용으로 수집하며 파일과 Git 상태를 변경하지 않는다.
- Git 저장소에서는 현재 소스로 재구성 가능한 구조 정보보다 commit, diff, ADR, 회고, 운영 문서에 남은 변경 이유와 제약, 실패, 검증 결과를 우선 추출한다.
- 각 Memory는 원천 종류와 원천 식별자를 provenance로 보존하고 원문을 복제하지 않는다.

## Experience Memory LLM 모델

- 지식 추출 또는 지식 검색 경로에서 LLM을 호출할 때는 `gpt-5.6-luna`를 사용한다.
- 해당 경로에서는 환경 변수나 호출 옵션으로 다른 모델을 선택할 수 없게 검증한다.
- `gpt-5.6-luna`를 사용할 수 없으면 더 비싼 모델로 대체하지 말고 명시적으로 실패한다.
- LLM 호출이 필요 없는 정규화, 색인, lexical 검색은 결정적인 구현을 우선한다.

<!-- MEMORY-SEARCH-VOLUNTARY-POLICY:START -->
## Experience Memory voluntary search policy

- Search Experience Memory with `pnpm --silent memory-search -- --query <query> --project tc-ocr --allow-incomplete` before work that depends on historical decisions, compatibility constraints, incidents, migrations, or legacy behavior.
- Skip Memory search for clear code-only edits where the current source and local tests fully define the change.
- If Memory results have low confidence, `uncertain` status, or conflicting sources, open the original source reference before relying on them.
- Experience Memory is supporting context only. Current source code, current tests, and explicit task instructions win when they conflict with Memory.
<!-- MEMORY-SEARCH-VOLUNTARY-POLICY:END -->
