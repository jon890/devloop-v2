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

// S2a 정규화 회귀 — 적재기 normalizeConceptKey와 같은 판정식으로 적재기 회귀를 감시한다. 비율 < 1%
MATCH (c:Concept)
WHERE c.name IS NOT NULL
WITH reduce(
  normalized = '',
  index IN range(0, size(toLower(c.name)) - 1) |
  normalized + CASE
    WHEN substring(toLower(c.name), index, 1) =~ '[a-z0-9가-힣]'
    THEN substring(toLower(c.name), index, 1)
    ELSE ''
  END
) AS normalizedName, collect(c.name) AS names
WHERE size(names) > 1
WITH count(*) AS duplicateGroups,
     coalesce(sum(size(names)), 0) AS duplicateNodes
MATCH (allConcepts:Concept)
RETURN count(allConcepts) AS totalConcepts,
       duplicateGroups,
       duplicateNodes,
       toFloat(duplicateNodes) / count(allConcepts) AS duplicateRatio;

// S2b 근사 중복 탐지 — 어순 차이 후보. 오탐이 섞이므로 통과선 없이 쌍 수와 예시만 기록한다.
MATCH (a:Concept), (b:Concept)
WHERE a.name IS NOT NULL AND b.name IS NOT NULL AND a.name < b.name
WITH a, b,
     [token IN split(toLower(trim(replace(replace(replace(replace(a.name, '.', ' '), '-', ' '), '_', ' '), '/', ' '))), ' ') WHERE token <> ''] AS aTokens,
     [token IN split(toLower(trim(replace(replace(replace(replace(b.name, '.', ' '), '-', ' '), '_', ' '), '/', ' '))), ' ') WHERE token <> ''] AS bTokens
WHERE size(aTokens) > 1
  AND size(aTokens) = size(bTokens)
  AND all(token IN aTokens WHERE token IN bTokens)
  AND all(token IN bTokens WHERE token IN aTokens)
  AND aTokens <> bTokens
WITH collect({left: a.name, right: b.name}) AS pairs
RETURN 'word-order' AS detector,
       size(pairs) AS pairCount,
       pairs[0..20] AS examples;

// S2b 근사 중복 탐지 — 부분포함 후보. Document ⊂ Document.Console 같은 별개 개체도 잡는 오탐이 섞인다.
MATCH (a:Concept), (b:Concept)
WHERE a.name IS NOT NULL
  AND b.name IS NOT NULL
  AND a.name < b.name
  AND (
    toLower(b.name) CONTAINS toLower(a.name)
    OR toLower(a.name) CONTAINS toLower(b.name)
  )
WITH collect({left: a.name, right: b.name}) AS pairs
RETURN 'substring' AS detector,
       size(pairs) AS pairCount,
       pairs[0..20] AS examples;

// S3 사전 적중 — 연결 수 5개 이상인 고빈도 Concept 중 사전 적중률 ≥ 50%
MATCH (c:Concept)
OPTIONAL MATCH (c)-[relationship]-()
WITH c, count(relationship) AS degree
WHERE degree >= 5
RETURN count(c) AS highFrequencyConcepts,
       sum(CASE WHEN c.dictMatched = true THEN 1 ELSE 0 END) AS dictionaryMatches,
       avg(CASE WHEN c.dictMatched = true THEN 1.0 ELSE 0.0 END) AS hitRatio;

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
