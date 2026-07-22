import { Module } from '@nestjs/common';
import { ChildProcessDoorayExecutor } from './dooray-executor';
import { DOORAY_EXECUTOR, IngestService } from './ingest.service';

@Module({
  providers: [
    {
      provide: DOORAY_EXECUTOR,
      useClass: ChildProcessDoorayExecutor,
    },
    IngestService,
  ],
  exports: [IngestService],
})
export class IngestModule {}
