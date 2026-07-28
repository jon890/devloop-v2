CREATE CONSTRAINT project_code_unique IF NOT EXISTS FOR (n:Project) REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT task_number_unique IF NOT EXISTS FOR (n:Task) REQUIRE n.number IS UNIQUE;
CREATE CONSTRAINT wiki_page_id_unique IF NOT EXISTS FOR (n:Wiki) REQUIRE n.pageId IS UNIQUE;
CREATE CONSTRAINT person_member_id_unique IF NOT EXISTS FOR (n:Person) REQUIRE n.memberId IS UNIQUE;
CREATE CONSTRAINT comment_comment_id_unique IF NOT EXISTS FOR (n:Comment) REQUIRE n.commentId IS UNIQUE;
CREATE CONSTRAINT concept_name_unique IF NOT EXISTS FOR (n:Concept) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT decision_id_unique IF NOT EXISTS FOR (n:Decision) REQUIRE n.id IS UNIQUE;

CREATE FULLTEXT INDEX task_subject_fulltext IF NOT EXISTS FOR (n:Task) ON EACH [n.subject] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } };
CREATE FULLTEXT INDEX wiki_subject_fulltext IF NOT EXISTS FOR (n:Wiki) ON EACH [n.subject] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } };
CREATE FULLTEXT INDEX concept_name_fulltext IF NOT EXISTS FOR (n:Concept) ON EACH [n.name] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } };
