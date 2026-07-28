import { Module } from "@nestjs/common";
import { ApiController } from "./api.controller";
import { GraphController } from "./graph/graph.controller";
import { GraphQueryService } from "./graph-query.service";
import { createLlmCli, LLM_CLI } from "./llm-cli";
import { Neo4jService } from "./neo4j.service";
import { OntologyController } from "./ontology.controller";

@Module({
  controllers: [ApiController, GraphController, OntologyController],
  providers: [
    Neo4jService,
    GraphQueryService,
    {
      provide: LLM_CLI,
      useFactory: createLlmCli,
    },
  ],
})
export class AppModule {}
