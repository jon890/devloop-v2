import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { GraphQueryService } from './graph-query.service';
import { createLlmCli, LLM_CLI } from './llm-cli';
import { Neo4jService } from './neo4j.service';

@Module({
  controllers: [ApiController],
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
