/** 테스트에서 쓰는 최소 ApiConfig. 필요한 필드만 override 한다. */
function testApiConfig(overrides = {}) {
  return {
    port: 3000,
    neo4j: {
      uri: 'bolt://localhost:7687',
      database: 'neo4j',
      user: 'neo4j',
      password: 'test-password',
      ...(overrides.neo4j ?? {}),
    },
    llm: {
      provider: 'codex',
      queryModel: 'configured-query-model',
      reasoningEffort: 'high',
      ...(overrides.llm ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'neo4j' && key !== 'llm')),
  };
}

module.exports = { testApiConfig };
