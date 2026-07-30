import type { PipelineConfig } from "../config";

export function neo4jCredentials(config: PipelineConfig): { user: string; password: string } {
  return {
    user: config.neo4j.user,
    password: config.neo4j.password,
  };
}
