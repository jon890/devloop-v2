import { Body, Controller, Post } from "@nestjs/common";
import type { QueryRequest, QueryResponse } from "@devloop/shared";
import { GraphQueryService } from "./graph-query.service";

@Controller("api")
export class ApiController {
  constructor(private readonly graphQueryService: GraphQueryService) {}

  @Post("query")
  query(@Body() request: QueryRequest): Promise<QueryResponse> {
    return this.graphQueryService.query(request);
  }
}
