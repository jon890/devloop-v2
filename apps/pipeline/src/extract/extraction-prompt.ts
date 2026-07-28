import type { ConceptDictionary } from "@devloop/shared";
export { EXTRACTION_PROMPT_VERSION } from "./extraction-prompt.const";

export interface ExtractionPromptDocument {
  sourceDocId: string;
  label: "Task" | "Wiki";
  key: string;
  subject: string;
  content: string;
}

const FIXED_INSTRUCTIONS = `You extract a knowledge graph from exactly one source document.

Fixed ontology:
- Existing source nodes: Task(number), Wiki(pageId), Comment(commentId).
- LLM-created nodes: Concept(name, kind=product|component|type|tech|code-ref), Decision(id, summary, decidedAt?).
- Allowed relationships only: MENTIONS, DOCUMENTS, DEPENDS_ON, DECIDED_IN, EVIDENCED_BY, AFFECTS, RELATES_TO.
- Directions: Task|Wiki->Concept MENTIONS; Wiki->Concept DOCUMENTS; Concept->Concept DEPENDS_ON; Decision->Task DECIDED_IN; Decision->Task|Comment EVIDENCED_BY; Decision->Concept AFFECTS; Task->Task RELATES_TO.
- RELATES_TO properties.kind must be one of precedes, causes, follows-up.
- Use qualified endpoint keys such as Task:101, Wiki:201, Comment:c-1, Concept:OCR API, Decision:101-1.
- Every created node and every relationship MUST have properties.sourceDocId exactly equal to the supplied sourceDocId.
- Do not emit structural relationships such as CONTAINS, ASSIGNED_TO, AUTHORED, COMMENTED, HAS_COMMENT, TAGGED, REFERENCES, CHILD_OF.
- Prefer a canonical Concept from the allowed dictionary. Use an alias only to locate its canonical name. Create a new Concept name only when no dictionary entry represents it and the document clearly names it.
- Emit only evidence explicitly supported by the document. Return an empty array instead of guessing.

Required JSON shape (no markdown fences, no prose):
{
  "nodes": [
    {"label":"Concept","key":"canonical name","properties":{"name":"canonical name","kind":"component","sourceDocId":"Task:101"}},
    {"label":"Decision","key":"101-1","properties":{"id":"101-1","summary":"decision summary","decidedAt":"2025-01-02","sourceDocId":"Task:101"}}
  ],
  "relationships": [
    {"type":"MENTIONS","startKey":"Task:101","endKey":"Concept:canonical name","properties":{"sourceDocId":"Task:101"}},
    {"type":"RELATES_TO","startKey":"Task:101","endKey":"Task:100","properties":{"kind":"follows-up","sourceDocId":"Task:101"}}
  ]
}

Few-shot example:
sourceDocId=Task:42, subject="[OCR.API] gateway removal", content="We decided to remove API Gateway because it caused timeouts. Follow-up: demo/41. Evidence is comment c-7."
output={"nodes":[{"label":"Concept","key":"API Gateway","properties":{"name":"API Gateway","kind":"component","sourceDocId":"Task:42"}},{"label":"Decision","key":"42-1","properties":{"id":"42-1","summary":"Remove API Gateway because it caused timeouts","sourceDocId":"Task:42"}}],"relationships":[{"type":"MENTIONS","startKey":"Task:42","endKey":"Concept:API Gateway","properties":{"sourceDocId":"Task:42"}},{"type":"DECIDED_IN","startKey":"Decision:42-1","endKey":"Task:42","properties":{"sourceDocId":"Task:42"}},{"type":"EVIDENCED_BY","startKey":"Decision:42-1","endKey":"Comment:c-7","properties":{"sourceDocId":"Task:42"}},{"type":"AFFECTS","startKey":"Decision:42-1","endKey":"Concept:API Gateway","properties":{"sourceDocId":"Task:42"}},{"type":"RELATES_TO","startKey":"Task:42","endKey":"Task:41","properties":{"kind":"follows-up","sourceDocId":"Task:42"}}]}`;

export function buildExtractionPrompt(document: ExtractionPromptDocument, concepts: ConceptDictionary): string {
  const dictionary = concepts.map((entry) => ({
    canonical: entry.canonical,
    kind: entry.kind,
    aliases: entry.aliases,
  }));
  return `${FIXED_INSTRUCTIONS}

Allowed Concept dictionary:
${JSON.stringify(dictionary)}

Source document:
${JSON.stringify(document)}

Return the required JSON object now.`;
}

export function buildJsonRepairPrompt(originalPrompt: string, invalidResponse: string): string {
  return `${originalPrompt}

Your previous response was invalid JSON or violated the required schema:
${invalidResponse}

Correct it once. Return only one valid JSON object matching the exact required shape.`;
}
