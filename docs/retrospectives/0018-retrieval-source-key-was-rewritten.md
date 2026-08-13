---
id: RETRO-0018
plan: plan015-memory-retrieval-spike
date: 2026-08-13
phase: review-gate
status: 해결
category: 결함
promotion: 승격 안 함
---

# 검색 관측의 원천 key 불일치가 출력에서 덮어써졌다

## 관찰

독립 코드 리뷰에서 raw observation의 `sourceRunKey`를 non-empty로만 검사하고 출력 lock에는 현재 attempt key를 새로 쓰는 동작을 발견했다.

## 원인

출력 정규화와 provenance 검증을 같은 단계로 취급해 입력 key와 현재 attempt의 동일성을 확인하지 않았다.

## 영향

잘못 연결된 검색 관측도 올바른 attempt에서 나온 것처럼 보일 수 있어 실제 miss 추적 신뢰성을 낮췄다.

## 대응

관측 key가 `${taskId}:${condition}:${repetition}` 형식이며 현재 attempt key와 정확히 같을 때만 통과하도록 fail-close했다.

## 검증

다른 task key를 주입하면 `sourceRunKey mismatch`로 실패하는 회귀 테스트를 추가했다.

## 배운 점

provenance 필드는 출력에서 재작성하지 말고 입력과 실행 문맥의 동일성을 먼저 검증해야 한다.

## 후속

추가 후속은 없다.
