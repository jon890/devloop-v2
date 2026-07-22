// 온톨로지 정적 기준 측정 쿼리 — docs/EVAL-RUBRIC.md 섹션 1과 1:1
// 실행: cypher-shell 또는 Neo4j Browser 에서 개별 실행 후 통과선과 비교

// S1 스키마 정합 — 계약 밖 라벨 (결과 0 이어야 통과)
MATCH (n) WITH DISTINCT labels(n) AS ls UNWIND ls AS l
WITH l WHERE NOT l IN ['Project','Task','Wiki','Person','Comment','Concept','Decision']
RETURN l;

// S1 스키마 정합 — 계약 밖 관계 (결과 0 이어야 통과)
MATCH ()-[r]->() WITH DISTINCT type(r) AS t
WITH t WHERE NOT t IN ['CONTAINS','ASSIGNED_TO','AUTHORED','COMMENTED','HAS_COMMENT','TAGGED','REFERENCES','CHILD_OF','MENTIONS','DOCUMENTS','DEPENDS_ON','DECIDED_IN','EVIDENCED_BY','AFFECTS','RELATES_TO','IN_MILESTONE']
RETURN t;

// S2 Concept 응집 — 근사 중복 후보 (다른 이름인데 한쪽이 다른 쪽을 포함). 비율 < 5%
MATCH (a:Concept), (b:Concept)
WHERE a.name < b.name AND (toLower(b.name) CONTAINS toLower(a.name))
RETURN a.name, b.name;

// S3 사전 적중 — origin='llm' Concept 중 사전 매칭 비율 ≥ 80% (dictMatched 는 적재 시 기록)
MATCH (c:Concept) WHERE c.origin = 'llm'
RETURN avg(CASE WHEN c.dictMatched THEN 1.0 ELSE 0.0 END) AS hitRatio;

// S4 연결성 — 고아 Task 비율 < 10%
MATCH (t:Task)
OPTIONAL MATCH (t)-[r]-() WHERE type(r) <> 'CONTAINS'
WITH t, count(r) AS deg
RETURN avg(CASE WHEN deg = 0 THEN 1.0 ELSE 0.0 END) AS orphanRatio;

// S5 추출 밀도 — Task 당 평균 MENTIONS ≥ 1.5
MATCH (t:Task)
OPTIONAL MATCH (t)-[m:MENTIONS]->()
WITH t, count(m) AS mc
RETURN avg(mc) AS avgMentions;

// S6 근거 추적 — LLM 생성 관계의 sourceDocId 보유 비율 = 100%
MATCH ()-[r]->() WHERE type(r) IN ['MENTIONS','DOCUMENTS','DEPENDS_ON','DECIDED_IN','EVIDENCED_BY','AFFECTS','RELATES_TO']
RETURN avg(CASE WHEN r.sourceDocId IS NOT NULL THEN 1.0 ELSE 0.0 END) AS sourcedRatio;
