# 실행 기록

스킬 실행마다 한 줄 남긴다. 몇 번 뒤에 추세가 보인다.

| 날짜 | 스킬 | 대상 | 모드 | phase | REVISE | FIX | DOCS | BLOCK | 개입 | 결과 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | :---: | ---: | --- |
| 2026-07-30 | planning | plan002-pipeline-config, plan003-registry-curation | — | 7 | — | — | 6 | 없음 | 6 | task 커밋 완료 |
| 2026-07-30 | build-with-teams | plan002-pipeline-config | B | 3 | — | 1 | 2 | 없음 | 1 | main 머지·원격 push 완료 |
| 2026-07-30 | build-with-teams | plan003-registry-curation | A | 4 | 0 | 2 | 1 | 없음 | 5 | 로컬 phase 커밋 완료, push·PR 생략 |
| 2026-07-31 | planning | plan005-kg-eval-runner | - | 4 | - | - | - | 없음 | 1 | task 커밋 완료 |
| 2026-07-31 | build-with-teams | plan005-kg-eval-runner | C | 4 | 0 | 9 | 0 | 없음 | 0 | Phase04 기준선 재실행·리포트·검증 완료, 독립 리뷰 3라운드 수정 완료 |
| 2026-08-03 | planning | plan006-evidence-retrieval | — | 4 | — | — | 5 | 없음 | 7 | task 커밋 완료. 1단계 실측이 계획 방향을 바꿨다 |
| 2026-08-03 | build-with-teams | plan006-evidence-retrieval | B | 4 | — | — | — | 없음 | 4 | 로컬 phase 커밋 완료, push·PR 생략(지시). 스펙 결함 3건을 조정자 확인으로 고쳤다 |
| 2026-08-03 | plan007 | plan007-evidence-budget | — | — | 1 | — | 4 | 없음 | 0 | 근거 상한을 길이 예산으로, Cypher 를 모든 업무 댓글 확장으로. 회수 (12,12) → (7,9) 로 구간 비겹침. 독립 검토가 blocker 1건을 측정 전에 잡았다 |
| 2026-08-04 | plan008 | plan008-cypher-row-budget | — | — | — | — | 2 | 없음 | 0 | 다수 업무 확장을 collect 로 접었다. 회수 실패 (7,9) → (2,2) 로 변동 0. 지연은 44 → 70~78초로 늘었다 |
| 2026-08-04 | plan009 | plan009-suite-growth | — | — | — | — | 2 | 없음 | 0 | 비교를 문항 id 교집합으로. collect 집계 오판정 제거, 근거 업무의 댓글을 그래프 조회로 보강. 회수 (2,2) 유지하며 지연 74 → 59초 |
| 2026-08-04 | planning | plan010-persistent-llm-transport | — | 5 | — | — | 5 | 없음 | 6 | task 커밋 완료. 상주 app-server 실측이 계획을 두 번 바꿨다 — exec-server 는 미구현이었고, 파이프라인 outputSchema 는 계약 패키지 연쇄 이전을 부르는 것을 발견해 범위에서 뺐다 |
| 2026-08-05 | plan010 | plan010-persistent-llm-transport | — | 5 | — | — | 3 | 없음 | 0 | 전송 전환은 개선(59.7→41.6\~44.2초)이나 outputSchema 가 그중 9.9\~17.9초를 되돌려 최종 상태(54.1\~59.5초)는 기준값과 사실상 구분 안 됨. 회수는 유지(0\~2건). plan 완료 마킹 |
| 2026-08-05 | build-with-teams | plan010-persistent-llm-transport | A | 5 | 2 | 1 | 1 | 없음 | 0 | PR #2. spec 결함 13건을 critic·구현이 잡았고 독립 검토가 소켓 끊김 무한 대기를 잡았다. 회고 7건(0011\~0017). 조율자에게 질의 2회 보냈으나 무응답이라 보수적 가정으로 진행하고 근거를 보고했다 |
| 2026-08-06 | planning | plan011-direct-responses-transport | — | 5 | — | — | 5 | 없음 | 4 | task 커밋 완료. 탐침이 plan010 의 결론을 정정했다 — outputSchema 비용은 형식 강제가 아니라 출력 분량이었고, 몰아 재기가 만든 착오도 함께 드러났다 |
| 2026-08-06 | plan011 | plan011-direct-responses-transport | — | 5 | 0 | 0 | 1 | 없음 | 2 | Responses 직접 호출을 기본으로 전환했다. 교차 측정에서 문자당 처리는 빨랐지만 답변이 길어 실제 총지연은 회귀했고, 답변 분량을 후속 과제로 남겼다 |
| 2026-08-11 | planning | plan012-experience-memory | — | 4 | — | — | 9 | 없음 | 2 | 기존 관리 문서와 task만 갱신했다. 계획 lane과 구현 lane을 분리하고 세 원천, 원문 link, Luna 고정, bounded 파일럿을 확정했다 |
| 2026-08-11 | build-with-teams | plan012-experience-memory | standard | 4 | 0 | 5 | 7 | 없음 | 0 | 최신 Dooray raw와 OCR Git 9개 repo 수직 검증 완료. schema v2로 Structured Outputs 400을 해소했고 최종 bounded 재실행 calls 0/cacheHits 12, Wiki 37문서, 검색 smoke 1/6/0건을 기록했다 |
| 2026-08-12 | planning | plan013~017-memory-evaluation | — | 5 | — | — | — | 없음 | 0 | #3~#12 전체 완료를 평가 기반, utility, retrieval, Graph, automatic의 다섯 PR로 분리하고 source-locked 계약을 확정했다 |
| 2026-08-12 | build-with-teams | plan013-memory-eval-foundation | A | 4 | 3 | 2 | 3 | 있음 | 0 | source-locked suite와 두 Agent voluntary 계측을 구현했다. Claude 첫 task timeout을 보존하고 두 번째 task에서 검색 2회, validation 성공, wrong edit 0건을 확인했다. 독립 code·docs 검토를 통과했다 |
| 2026-08-13 | build-with-teams | plan014-memory-utility-eval | standard | 3 | 0 | 3 | 3 | 없음 | 0 | Luna low로 36회 수집했다. 9개 stable success, 2개 unstable, 1개 regression이며 voluntary trigger는 TP 0/FN 6, lexical miss 0이었다. privacy 0, 결정적 report와 독립 검증을 완료했다 |
| 2026-08-13 | build-with-teams | plan015-memory-retrieval-spike | B→A(p3) | 3 | 0 | 1 | 1 | 없음 | 0 | Plan014의 36회 raw와 private lock을 재검증해 lexical miss 0을 확정했다. retrieval adapter와 production 변경을 만들지 않고 NO_CHANGE, adapter 0, privacy violation 0으로 닫았다. 독립 리뷰에서 sourceRunKey provenance fail-close를 보강했다 |
