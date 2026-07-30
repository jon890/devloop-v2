import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import neo4j from "neo4j-driver";
import { type PipelineConfig, withPipelineConfig } from "../config";
import { neo4jCredentials, requireNeo4jConfig } from "./neo4j-config";

export async function applySchema(config: PipelineConfig): Promise<void> {
  const dbConfig = requireNeo4jConfig(config, "apply-schema");
  const uri = dbConfig.neo4j.uri;
  const { user, password } = neo4jCredentials(dbConfig);
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database: "neo4j" });

  try {
    const source = await readFile(resolve(__dirname, "schema.cy"), "utf8");
    const statements = source
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await session.run(statement);
    }
    console.log(`Applied ${statements.length} Neo4j schema statements.`);
  } finally {
    await session.close();
    await driver.close();
  }
}

if (require.main === module) {
  void withPipelineConfig((config) => applySchema(config)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
