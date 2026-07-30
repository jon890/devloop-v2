import type { PipelineConfig } from "../config";

export type PipelineConfigWithNeo4jUri = PipelineConfig & {
  neo4j: PipelineConfig["neo4j"] & { uri: string };
};

export function requireNeo4jConfig(config: PipelineConfig, commandName: string): PipelineConfigWithNeo4jUri {
  if (!config.neo4j.uri) {
    throw new Error(`${commandName} 는 NEO4J_URI 환경변수가 있어야 실행됩니다.`);
  }
  return config as PipelineConfigWithNeo4jUri;
}

export function neo4jCredentials(config: PipelineConfig): { user: string; password: string } {
  return {
    user: config.neo4j.user,
    password: config.neo4j.password,
  };
}
