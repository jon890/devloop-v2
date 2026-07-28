import { z } from "zod";

export const AnchorResponseSchema = z.object({ terms: z.array(z.string().min(1)).min(1) });
export const CypherResponseSchema = z.object({ cypher: z.string().trim().min(1) });
export const AnswerResponseSchema = z.object({ answer: z.string().trim().min(1) });
