import { z } from 'zod';
import { ConceptKindSchema } from './ontology';

export const ConceptEntrySchema = z.object({
  canonical: z.string().min(1),
  kind: ConceptKindSchema,
  aliases: z.array(z.string().min(1)),
});
export type ConceptEntry = z.infer<typeof ConceptEntrySchema>;

export const ConceptDictionarySchema = z.array(ConceptEntrySchema);
export type ConceptDictionary = z.infer<typeof ConceptDictionarySchema>;

export const CORE_CONCEPTS = [
  { canonical: 'REST API', kind: 'tech', aliases: ['REST', 'RESTful API'] },
  { canonical: 'TypeScript', kind: 'tech', aliases: ['TS'] },
  { canonical: 'NestJS', kind: 'tech', aliases: ['Nest.js', 'Nest'] },
  { canonical: 'React', kind: 'tech', aliases: ['React.js'] },
  { canonical: 'Neo4j', kind: 'tech', aliases: ['Neo4J'] },
  { canonical: 'Docker', kind: 'tech', aliases: ['도커'] },
] as const satisfies ConceptDictionary;
