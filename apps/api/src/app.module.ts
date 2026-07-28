import { Module } from "@nestjs/common";
import { API_CONFIG, ApiConfigModule } from "./config";
import { GraphController } from "./graph/graph.controller";
import { GraphQueryService } from "./graph-query.service";
import { createLlmCli, LLM_CLI } from "./llm-cli";
import { Neo4jService } from "./neo4j.service";
import { OntologyController } from "./ontology.controller";
import { QueryController } from "./query/query.controller";
import { QueryService } from "./query/query.service";

@Module({
  imports: [ApiConfigModule],
  controllers: [QueryController, GraphController, OntologyController],
  providers: [
    Neo4jService,
    GraphQueryService,
    QueryService,
    {
      provide: LLM_CLI,
      useFactory: createLlmCli,
      inject: [API_CONFIG],
    },
  ],
})
export class AppModule {}
