import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { API_CONFIG, ApiConfigModule } from "./config";
import { GraphController } from "./graph/graph.controller";
import { GraphQueryService } from "./graph-query.service";
import { createLlmCli, LLM_CLI, type LlmCli } from "./llm-cli";
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
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(LLM_CLI) private readonly llmCli: LlmCli) {}

  /**
   * 상주 어댑터가 자기 `codex app-server` 를 죽인다.
   * `claude` 어댑터는 `close` 를 구현하지 않으므로 옵셔널 호출이 그대로 통과한다.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.llmCli.close?.();
  }
}
