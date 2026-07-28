import { Module } from "@nestjs/common";
import { GraphController } from "./graph/graph.controller";
import { GraphQueryService } from "./graph-query.service";
import { createLlmCli, LLM_CLI } from "./llm-cli";
import { Neo4jService } from "./neo4j.service";
import { OntologyController } from "./ontology.controller";
import { QueryController } from "./query/query.controller";
import { QueryService } from "./query/query.service";

@Module({
  controllers: [QueryController, GraphController, OntologyController],
  providers: [
    Neo4jService,
    GraphQueryService,
    QueryService,
    {
      provide: LLM_CLI,
      useFactory: createLlmCli,
    },
  ],
})
export class AppModule {}
