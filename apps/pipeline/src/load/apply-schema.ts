import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import neo4j from 'neo4j-driver';

function neo4jCredentials(): { user: string; password: string } {
  const envUser = process.env.NEO4J_USER;
  const envPassword = process.env.NEO4J_PASSWORD;
  if (envUser && envPassword) {
    return { user: envUser, password: envPassword };
  }

  const [user = 'neo4j', password = 'devloop-password'] = (
    process.env.NEO4J_AUTH ?? 'neo4j/devloop-password'
  ).split('/', 2);
  return { user, password };
}

async function applySchema(): Promise<void> {
  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const { user, password } = neo4jCredentials();
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database: 'neo4j' });

  try {
    const source = await readFile(resolve(__dirname, 'schema.cy'), 'utf8');
    const statements = source
      .split(';')
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

void applySchema();
