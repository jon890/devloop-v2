import { Controller, Get, Param, Query } from '@nestjs/common';
import type {
  GraphSearchResponse,
  GraphStatsResponse,
  NeighborsResponse,
} from '@devloop/shared';
import { GraphQueryService } from '../graph-query.service';

@Controller('api')
export class GraphController {
  constructor(private readonly graphQueryService: GraphQueryService) {}

  @Get('graph/stats')
  stats(): Promise<GraphStatsResponse> {
    return this.graphQueryService.stats();
  }

  @Get('graph/nodes/:id/neighbors')
  neighbors(@Param('id') id: string, @Query('depth') depth = '1'): Promise<NeighborsResponse> {
    return this.graphQueryService.neighbors(id, depth);
  }

  @Get('graph/search')
  search(@Query('q') q = ''): Promise<GraphSearchResponse> {
    return this.graphQueryService.search(q);
  }

  @Get('graph/samples')
  samples(
    @Query('label') label = '',
    @Query('relationship') relationship = '',
  ): Promise<NeighborsResponse> {
    return this.graphQueryService.samples(label, relationship);
  }
}
