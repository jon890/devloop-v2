require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GraphQueryService } = require('../dist/graph-query.service');

function createService() {
  const queries = [];
  const evidence = { nodes: [], relationships: [] };
  const session = {
    run: async (query) => {
      queries.push(query);
      return evidence;
    },
  };
  const neo4jService = {
    executeRead: (work) => work(session),
    evidenceFromResult: (result) => result,
  };
  return {
    queries,
    service: new GraphQueryService(neo4jService, {}),
  };
}

test('graph samples query only interpolates validated ontology labels and relationships', async () => {
  const { queries, service } = createService();

  assert.deepEqual(await service.samples('Task'), { nodes: [], relationships: [] });
  assert.match(queries[0], /^MATCH \(node:Task\) RETURN node LIMIT 5$/);

  assert.deepEqual(await service.samples('', 'DECIDED_IN'), {
    nodes: [],
    relationships: [],
  });
  assert.match(queries[1], /MATCH \(start\)-\[relationship:DECIDED_IN\]->\(end\)/);
});

test('graph samples rejects unknown or missing types before querying Neo4j', async () => {
  const { queries, service } = createService();

  await assert.rejects(service.samples('Task) MATCH (n)', ''), /known ontology node label/);
  await assert.rejects(service.samples('', 'DELETE_ALL'), /known ontology relationship type/);
  await assert.rejects(service.samples(), /label or relationship query is required/);
  assert.equal(queries.length, 0);
});
