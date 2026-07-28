import { z } from "zod";
import { ConceptKindSchema } from "../ontology/ontology.schema";

export const ConceptEntrySchema = z.object({
  canonical: z.string().min(1),
  kind: ConceptKindSchema,
  aliases: z.array(z.string().min(1)),
});
export type ConceptEntry = z.infer<typeof ConceptEntrySchema>;

export const ConceptDictionarySchema = z.array(ConceptEntrySchema);
export type ConceptDictionary = z.infer<typeof ConceptDictionarySchema>;
