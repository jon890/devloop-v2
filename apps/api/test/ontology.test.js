require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');
const {
  GraphSamplesResponseSchema,
  NODE_LABELS,
  OntologyResponseSchema,
  RELATIONSHIP_TYPES,
} = require('@devloop/shared');
const { AppModule } = require('../dist/app.module');
const { OntologyController } = require('../dist/ontology.controller');

test('ontology controller is registered at GET /api/ontology', () => {
  const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule);

  assert.ok(controllers.includes(OntologyController));
  assert.equal(Reflect.getMetadata(PATH_METADATA, OntologyController), 'api');
  assert.equal(Reflect.getMetadata(PATH_METADATA, OntologyController.prototype.ontology), 'ontology');
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, OntologyController.prototype.ontology),
    RequestMethod.GET,
  );
});

test('ontology response exposes the shared node and relationship contract', () => {
  const response = OntologyResponseSchema.parse(new OntologyController().ontology());

  assert.deepEqual(response.nodes.map((node) => node.label), NODE_LABELS);
  assert.equal(response.nodes.length, 7);
  assert.ok(response.nodes.every((node) => node.properties.includes(node.key)));
  assert.ok(response.nodes.every((node) => /[가-힣]/.test(node.description)));

  assert.deepEqual(response.relationships.map((relationship) => relationship.type), RELATIONSHIP_TYPES);
  assert.equal(response.relationships.length, 15);
  assert.ok(response.relationships.every((relationship) => relationship.directions.length >= 1));
  assert.ok(response.relationships.every((relationship) => /[가-힣]/.test(relationship.description)));

  assert.deepEqual(directionsFor(response, 'CONTAINS'), [
    'Project->Task',
    'Project->Wiki',
  ]);
  assert.deepEqual(directionsFor(response, 'CHILD_OF'), ['Task->Task', 'Wiki->Wiki']);
  assert.deepEqual(directionsFor(response, 'MENTIONS'), ['Task->Concept', 'Wiki->Concept']);
  assert.deepEqual(directionsFor(response, 'EVIDENCED_BY'), [
    'Decision->Task',
    'Decision->Comment',
  ]);
});

test('graph samples response reuses the evidence contract', () => {
  const sample = GraphSamplesResponseSchema.parse({
    nodes: [],
    relationships: [],
  });

  assert.deepEqual(sample, { nodes: [], relationships: [] });
});

function directionsFor(response, type) {
  return response.relationships
    .find((relationship) => relationship.type === type)
    .directions.map((direction) => `${direction.from}->${direction.to}`);
}
