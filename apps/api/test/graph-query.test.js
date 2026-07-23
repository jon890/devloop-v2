const assert = require('node:assert/strict');
const { test } = require('node:test');
const { refineQueryEvidence } = require('../dist/graph-query.service');

function node(id, label, display = id) {
  return { id, label, key: id, display, properties: {} };
}

test('query evidence prioritizes answer nodes, filters orphan anchors, and caps nodes at 30', () => {
  const answerNodes = [
    node('answer-concept', 'Concept'),
    node('answer-task', 'Task'),
  ];
  const supportingNodes = Array.from({ length: 35 }, (_, index) =>
    node(`support-${index}`, index % 2 === 0 ? 'Task' : 'Concept'),
  );
  const relationships = supportingNodes.map((supportingNode, index) => ({
    id: `relationship-${index}`,
    type: 'RELATES_TO',
    startId: answerNodes[index % answerNodes.length].id,
    endId: supportingNode.id,
    properties: {},
  }));
  const connectedAnchor = node('connected-anchor', 'Wiki');
  relationships.push({
    id: 'anchor-relationship',
    type: 'RELATES_TO',
    startId: 'answer-task',
    endId: connectedAnchor.id,
    properties: {},
  });

  const evidence = refineQueryEvidence(
    { nodes: answerNodes, relationships: [] },
    { nodes: supportingNodes, relationships },
    [connectedAnchor, node('orphan-anchor', 'Task')],
  );

  assert.equal(evidence.nodes.length, 30);
  assert.deepEqual(
    evidence.nodes.slice(0, 2).map((item) => item.id),
    ['answer-task', 'answer-concept'],
  );
  assert.ok(evidence.nodes.some((item) => item.id === 'connected-anchor'));
  assert.ok(evidence.nodes.every((item) => item.id !== 'orphan-anchor'));
  const selectedIds = new Set(evidence.nodes.map((item) => item.id));
  assert.ok(
    evidence.relationships.every(
      (relationship) =>
        selectedIds.has(relationship.startId) && selectedIds.has(relationship.endId),
    ),
  );
});
