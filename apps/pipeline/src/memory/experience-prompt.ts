import { canonicalJson, type EvidencePacket } from "@devloop/shared";

export const EXPERIENCE_PROMPT_VERSION = "experience-memory-v1" as const;

export const EXPERIENCE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memories"],
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "kind",
          "status",
          "confidence",
          "summary",
          "why",
          "doNot",
          "scope",
          "validFrom",
          "validUntil",
          "lastVerified",
          "relatedTerms",
          "sourceRefKeys",
        ],
        properties: {
          title: { type: "string", minLength: 1, pattern: "^[^\\r\\n]+$" },
          kind: { type: "string", enum: ["decision", "constraint", "incident", "failed-attempt", "lesson"] },
          status: { type: "string", enum: ["active", "superseded", "deprecated", "historical", "uncertain"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          summary: { type: "string", minLength: 1 },
          why: { type: "string", minLength: 1 },
          doNot: { type: "array", items: { type: "string", minLength: 1 } },
          scope: {
            type: "object",
            additionalProperties: false,
            required: ["project", "repositories", "modules", "paths"],
            properties: {
              project: { type: "string", minLength: 1 },
              repositories: { type: "array", items: { type: "string", minLength: 1 } },
              modules: { type: "array", items: { type: "string", minLength: 1 } },
              paths: { type: "array", items: { type: "string", minLength: 1 } },
            },
          },
          validFrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          validUntil: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          lastVerified: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          relatedTerms: { type: "array", items: { type: "string", minLength: 1 } },
          sourceRefKeys: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
} as const;

export function buildExperiencePrompt(packet: EvidencePacket): string {
  return [
    `Experience Memory extraction policy ${EXPERIENCE_PROMPT_VERSION}.`,
    "Return only memories directly supported by this evidence packet.",
    "Extract only decision, constraint, incident, failed-attempt, or lesson knowledge that current source code cannot reliably reconstruct.",
    "Exclude current class names, symbols, locations, and caller/callee relationships that an agent should inspect in source.",
    "Summarize instead of copying quotations. If there is no direct evidence, return an empty memories array.",
    "Use status=uncertain when the evidence does not establish current validity.",
    "For provenance, select sourceRefKeys exactly as provided by the packet. Never create a source key, URL, source ID, or sourceRefs object.",
    "Keep title on one line. Do not infer dates, scope, prohibitions, or confidence beyond the evidence.",
    "One strict structured-output call is the entire extraction; there is no repair call.",
    "Evidence packet:",
    canonicalJson(packet),
  ].join("\n");
}
