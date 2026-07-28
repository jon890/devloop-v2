import { ConceptKindSchema, RelatesToKindSchema } from "@devloop/shared";
import { z } from "zod";

const SourcePropertiesSchema = z
  .object({
    sourceDocId: z.string().min(1),
  })
  .catchall(z.unknown());

export const LlmConceptNodeSchema = z
  .object({
    label: z.literal("Concept"),
    key: z.string().min(1),
    properties: z
      .object({
        name: z.string().min(1),
        kind: ConceptKindSchema,
        sourceDocId: z.string().min(1),
      })
      .catchall(z.unknown()),
  })
  .superRefine((node, context) => {
    if (node.key !== node.properties.name) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["key"], message: "Concept key must equal properties.name." });
    }
  });

export const LlmDecisionNodeSchema = z
  .object({
    label: z.literal("Decision"),
    key: z.string().min(1),
    properties: z
      .object({
        id: z.string().min(1),
        summary: z.string().min(1),
        decidedAt: z.string().optional(),
        sourceDocId: z.string().min(1),
      })
      .catchall(z.unknown()),
  })
  .superRefine((node, context) => {
    if (node.key !== node.properties.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["key"], message: "Decision key must equal properties.id." });
    }
    if (!/^\d+-\d+$/.test(node.key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["key"], message: "Decision key must be task-number-sequence." });
    }
  });

export const LlmNodeSchema = z.union([LlmConceptNodeSchema, LlmDecisionNodeSchema]);

export const LlmRelationshipSchema = z
  .object({
    type: z.enum(["MENTIONS", "DOCUMENTS", "DEPENDS_ON", "DECIDED_IN", "EVIDENCED_BY", "AFFECTS", "RELATES_TO"]),
    startKey: z.string().min(1),
    endKey: z.string().min(1),
    properties: SourcePropertiesSchema,
  })
  .superRefine((relationship, context) => {
    const endpointRules: Record<typeof relationship.type, [string[], string[]]> = {
      MENTIONS: [["Task:", "Wiki:"], ["Concept:"]],
      DOCUMENTS: [["Wiki:"], ["Concept:"]],
      DEPENDS_ON: [["Concept:"], ["Concept:"]],
      DECIDED_IN: [["Decision:"], ["Task:"]],
      EVIDENCED_BY: [["Decision:"], ["Task:", "Comment:"]],
      AFFECTS: [["Decision:"], ["Concept:"]],
      RELATES_TO: [["Task:"], ["Task:"]],
    };
    const [startPrefixes, endPrefixes] = endpointRules[relationship.type];
    if (!startPrefixes.some((prefix) => relationship.startKey.startsWith(prefix))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["startKey"], message: `${relationship.type} has an invalid start endpoint.` });
    }
    if (!endPrefixes.some((prefix) => relationship.endKey.startsWith(prefix))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["endKey"], message: `${relationship.type} has an invalid end endpoint.` });
    }
    if (relationship.type === "RELATES_TO") {
      const parsed = RelatesToKindSchema.safeParse(relationship.properties.kind);
      if (!parsed.success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["properties", "kind"],
          message: "RELATES_TO requires kind=precedes|causes|follows-up.",
        });
      }
    }
  });

export const LlmExtractionSchema = z
  .object({
    nodes: z.array(LlmNodeSchema),
    relationships: z.array(LlmRelationshipSchema),
  })
  .strict();

export type LlmExtraction = z.infer<typeof LlmExtractionSchema>;
