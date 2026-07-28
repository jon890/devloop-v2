import { Body, Controller, Post } from "@nestjs/common";
import type { QueryRequest, QueryResponse } from "@devloop/shared";
import { QueryService } from "./query.service";

@Controller("api")
export class QueryController {
  constructor(private readonly queryService: QueryService) {}

  @Post("query")
  query(@Body() request: QueryRequest): Promise<QueryResponse> {
    return this.queryService.query(request);
  }
}
