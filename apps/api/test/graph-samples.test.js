require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GraphQueryService } = require('../dist/graph-query.service');

function countResult(total) {
  return {
    records: [
      {
        get: (key) => {
          assert.equal(key, 'total');
          return total;
        },
      },
    ],
  };
}

function createService(run = async (query) => {
  if (query.includes('count(*)')) return countResult(12);
  return { evidence: { nodes: [], relationships: [] } };
}) {
  const queries = [];
  const session = {
    run: async (query, parameters) => {
      queries.push({ query, parameters });
      return run(query, parameters);
    },
  };
  const neo4jService = {
    executeRead: (work) => work(session),
    evidenceFromResult: (result) => result.evidence,
  };
  return {
    queries,
    service: new GraphQueryService(neo4jService, {}),
  };
}

function graphNode(id) {
  return {
    id,
    label: 'Task',
    key: id,
    display: id,
    properties: {},
  };
}

function numericParameters(parameters) {
  return {
    offset: parameters.offset.toNumber(),
    limit: parameters.limit.toNumber(),
  };
}

test('graph samples uses defaults and only interpolates validated ontology types', async () => {
  const { queries, service } = createService();

  assert.deepEqual(await service.samples('Task'), {
    nodes: [],
    relationships: [],
    total: 12,
    offset: 0,
    limit: 5,
  });
  assert.equal(queries[0].query, 'MATCH (node:Task) RETURN count(*) AS total');
  assert.match(
    queries[1].query,
    /^MATCH \(node:Task\) RETURN node ORDER BY node\.number, elementId\(node\) SKIP \$offset LIMIT \$limit$/,
  );
  assert.deepEqual(numericParameters(queries[1].parameters), { offset: 0, limit: 5 });

  assert.deepEqual(await service.samples('', 'DECIDED_IN'), {
    nodes: [],
    relationships: [],
    total: 12,
    offset: 0,
    limit: 5,
  });
  assert.equal(
    queries[2].query,
    'MATCH (start)-[relationship:DECIDED_IN]->(end) RETURN count(*) AS total',
  );
  assert.match(
    queries[3].query,
    /RETURN start, relationship, end ORDER BY .*elementId\(start\).*elementId\(end\), elementId\(relationship\) SKIP \$offset LIMIT \$limit$/,
  );
  assert.deepEqual(numericParameters(queries[3].parameters), { offset: 0, limit: 5 });
});

test('graph samples preserves label precedence when label and relationship are both provided', async () => {
  const { queries, service } = createService();

  await service.samples('Task', 'DECIDED_IN');

  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ query }) => query.includes('(node:Task)')));
  assert.ok(queries.every(({ query }) => !query.includes('DECIDED_IN')));
});

test('graph samples applies offset and limit through the last page', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => graphNode(`task-${index + 1}`));
  const { queries, service } = createService(async (query, parameters) => {
    if (query.includes('count(*)')) return countResult(rows.length);
    const { offset, limit } = numericParameters(parameters);
    return {
      evidence: {
        nodes: rows.slice(offset, offset + limit),
        relationships: [],
      },
    };
  });

  const middlePage = await service.samples('Task', '', '5', '5');
  assert.deepEqual(middlePage.nodes.map((node) => node.id), [
    'task-6',
    'task-7',
    'task-8',
    'task-9',
    'task-10',
  ]);
  assert.equal(middlePage.total, 12);
  assert.equal(middlePage.offset, 5);
  assert.equal(middlePage.limit, 5);

  const lastPage = await service.samples('Task', '', '10', '5');
  assert.deepEqual(lastPage.nodes.map((node) => node.id), ['task-11', 'task-12']);
  assert.equal(lastPage.total, 12);
  assert.equal(lastPage.offset, 10);
  assert.equal(lastPage.limit, 5);
  assert.deepEqual(numericParameters(queries.at(-1).parameters), { offset: 10, limit: 5 });
});

test('graph samples deterministic ordering keeps adjacent pages disjoint', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => graphNode(`task-${index + 1}`));
  const { service } = createService(async (query, parameters) => {
    if (query.includes('count(*)')) return countResult(rows.length);
    const { offset, limit } = numericParameters(parameters);
    const stable = query.includes('ORDER BY node.number, elementId(node)');
    const pageRows = stable
      ? rows.slice(offset, offset + limit)
      : offset === 0
        ? rows.slice(0, limit)
        : rows.slice(offset - 1, offset + limit - 1);
    return {
      evidence: {
        nodes: pageRows,
        relationships: [],
      },
    };
  });

  const firstPage = await service.samples('Task');
  const secondPage = await service.samples('Task', '', '5', '5');
  const firstIds = new Set(firstPage.nodes.map((node) => node.id));

  assert.equal(secondPage.nodes.some((node) => firstIds.has(node.id)), false);
});

test('graph samples rejects unknown, missing, or invalid query values before querying Neo4j', async () => {
  const { queries, service } = createService();

  await assert.rejects(service.samples('Task) MATCH (n)', ''), /known ontology node label/);
  await assert.rejects(service.samples('', 'DELETE_ALL'), /known ontology relationship type/);
  await assert.rejects(service.samples(), /label or relationship query is required/);
  await assert.rejects(service.samples('Task', '', '-1', '5'), (error) => error.getStatus() === 400);
  await assert.rejects(service.samples('Task', '', '1.5', '5'), (error) => error.getStatus() === 400);
  await assert.rejects(service.samples('Task', '', '0', '0'), (error) => error.getStatus() === 400);
  await assert.rejects(service.samples('Task', '', '0', '101'), (error) => error.getStatus() === 400);
  assert.equal(queries.length, 0);
});
