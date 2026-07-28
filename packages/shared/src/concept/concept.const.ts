import type { ConceptDictionary } from "./concept.schema";

export const CORE_CONCEPTS = [
  { canonical: "REST API", kind: "tech", aliases: ["REST", "RESTful API"] },
  { canonical: "TypeScript", kind: "tech", aliases: ["TS"] },
  { canonical: "NestJS", kind: "tech", aliases: ["Nest.js", "Nest"] },
  { canonical: "React", kind: "tech", aliases: ["React.js"] },
  { canonical: "Neo4j", kind: "tech", aliases: ["Neo4J"] },
  { canonical: "Docker", kind: "tech", aliases: ["도커"] },
] as const satisfies ConceptDictionary;
