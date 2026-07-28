export function neo4jCredentials(): { user: string; password: string } {
  const envUser = process.env.NEO4J_USER;
  const envPassword = process.env.NEO4J_PASSWORD;
  if (envUser && envPassword) {
    return { user: envUser, password: envPassword };
  }

  const [user = "neo4j", password = "devloop-password"] = (process.env.NEO4J_AUTH ?? "neo4j/devloop-password").split("/", 2);
  return { user, password };
}
