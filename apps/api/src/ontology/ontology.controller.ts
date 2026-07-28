import { Controller, Get } from "@nestjs/common";
import { ONTOLOGY_NODE_DEFINITIONS, ONTOLOGY_RELATIONSHIP_DEFINITIONS, type OntologyResponse } from "@devloop/shared";

@Controller("api")
export class OntologyController {
  @Get("ontology")
  ontology(): OntologyResponse {
    return {
      nodes: ONTOLOGY_NODE_DEFINITIONS.map((node) => ({
        ...node,
        properties: [...node.properties],
      })),
      relationships: ONTOLOGY_RELATIONSHIP_DEFINITIONS.map((relationship) => ({
        ...relationship,
        directions: [...relationship.directions],
        properties: "properties" in relationship ? [...relationship.properties] : undefined,
      })),
    };
  }
}
