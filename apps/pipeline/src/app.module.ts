import { Module } from "@nestjs/common";
import { ExtractModule } from "./extract.module";
import { IngestModule } from "./fetch/ingest.module";
import { LoadModule } from "./neo4j/load.module";

@Module({
  imports: [IngestModule, ExtractModule, LoadModule],
})
export class AppModule {}
