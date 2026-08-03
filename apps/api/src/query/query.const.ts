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
export const EVIDENCE_NODE_LIMIT = 30;
