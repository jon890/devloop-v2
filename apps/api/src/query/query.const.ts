import type { GraphNode } from "@devloop/shared";

// 제목·이름만으로는 닿지 않는 노드가 있다. 실측 — 정답 댓글 본문에 "모델 서버 envoy 버퍼 한도
// 병목" 이 그대로 적혀 있는데 그 업무 제목에는 질문의 단어가 하나도 없어 검색 경로가 없었다.
// 본문·댓글 인덱스는 기존 셋 뒤에 붙인다. 댓글 히트는 promoteCommentHits 가 부모 업무로 바꾼다.
export const FULLTEXT_INDEXES = [
  "task_subject_fulltext",
  "wiki_subject_fulltext",
  "concept_name_fulltext",
  "task_body_fulltext",
  "comment_excerpt_fulltext",
] as const;
// anchor 8개는 프롬프트 few-shot의 Task 후보 3개와 교차 라벨 문맥을 함께 담기 위한 상한이다.
// Wiki 최소 2개는 답변 근거에서 문서성 노드가 Task/Concept 점수에 밀려 사라지지 않게 하는 하한이다.
export const ANCHOR_CANDIDATE_LIMIT = 8;
// Task 최대 5, Wiki 최대 3, Concept 최대 2는 backfill 전 소프트 쿼터다.
// 후보가 부족하면 backfill이 최대를 넘어 채우고, Wiki는 최소 2개를 별도로 보장한다.
export const ANCHOR_LABEL_QUOTAS: Partial<Record<GraphNode["label"], { min?: number; max?: number }>> = {
  Task: { max: 5 },
  Wiki: { min: 2, max: 3 },
  Concept: { max: 2 },
};
// 근거는 개수가 아니라 **직렬화 길이**로 자른다. 노드 하나가 200자일 때와 6,000자일 때 비용이
// 30배 다른데 개수 기준은 둘을 같은 1로 센다. 실측 — 노드 30건 상한에서 정답 댓글이 6회 중 3회
// 떨어졌고, 그 회차의 직렬화 길이는 34,615자였다 (댓글이 살아남은 회차는 20,392~30,554자).
export const EVIDENCE_SERIALIZED_BUDGET = 60_000;
// 화면이 근거 그래프를 그리므로 개수 상한도 함께 둔다. 예산 안이라도 이 수를 넘기지 않는다.
export const EVIDENCE_NODE_CEILING = 80;
// 답변 합성 프롬프트에 담는 근거 예산이다. 노드 단위로 담아 JSON 구조를 깨지 않는다.
export const ANSWER_EVIDENCE_PROMPT_BUDGET = 20_000;
