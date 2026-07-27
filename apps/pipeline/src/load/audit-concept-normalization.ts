import neo4j, { type Driver } from 'neo4j-driver';
import {
  CONCEPT_KEY_MERGE_DENYLIST,
  normalizeConceptKey,
} from './load';
import { neo4jCredentials } from './neo4j-config';

interface ConceptSummary {
  name: string;
  degree: number;
}

async function readConcepts(driver: Driver): Promise<ConceptSummary[]> {
  const session = driver.session({
    database: 'neo4j',
    defaultAccessMode: neo4j.session.READ,
  });
  try {
    const result = await session.run(`
      MATCH (concept:Concept)
      OPTIONAL MATCH (concept)-[relationship]-()
      RETURN concept.name AS name, count(relationship) AS degree
      ORDER BY degree DESC, name
    `);
    return result.records.map((record) => ({
      name: record.get('name'),
      degree: record.get('degree').toNumber(),
    }));
  } finally {
    await session.close();
  }
}

function printReport(concepts: readonly ConceptSummary[]): void {
  const byKey = new Map<string, ConceptSummary[]>();
  for (const concept of concepts) {
    const key = normalizeConceptKey(concept.name);
    const group = byKey.get(key) ?? [];
    group.push(concept);
    byKey.set(key, group);
  }

  const duplicates = [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      concepts: group.sort(
        (left, right) =>
          right.degree - left.degree || left.name.localeCompare(right.name),
      ),
      deniedReason: CONCEPT_KEY_MERGE_DENYLIST.get(key),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const theoreticalMergedNodes = duplicates.reduce(
    (count, group) => count + group.concepts.length - 1,
    0,
  );
  const theoreticalMergedConnections = duplicates.reduce(
    (count, group) =>
      count +
      group.concepts
        .slice(1)
        .reduce((subtotal, concept) => subtotal + concept.degree, 0),
    0,
  );
  const loaderMergedNodes = duplicates.reduce(
    (count, group) =>
      count + (group.deniedReason ? 0 : group.concepts.length - 1),
    0,
  );
  const loaderMergedConnections = duplicates.reduce(
    (count, group) =>
      count +
      (group.deniedReason
        ? 0
        : group.concepts
            .slice(1)
            .reduce((subtotal, concept) => subtotal + concept.degree, 0)),
    0,
  );

  console.log(
    [
      `Concept 수: ${concepts.length}`,
      `중복 키 그룹: ${duplicates.length}`,
      `이론적 상한 - 통합 노드: ${theoreticalMergedNodes}`,
      `이론적 상한 - 흡수 연결: ${theoreticalMergedConnections}`,
      `적재기가 실제 통합하는 노드: ${loaderMergedNodes}`,
      `적재기가 실제 통합하는 연결: ${loaderMergedConnections}`,
      `부당 병합 제외 그룹: ${duplicates.filter((group) => group.deniedReason).length}`,
    ].join('\n'),
  );
  console.log('');

  duplicates.forEach((group, index) => {
    const verdict = group.deniedReason ? '병합 제외' : '병합 허용';
    const names = group.concepts
      .map((concept) => `${concept.name} [연결 ${concept.degree}]`)
      .join(' | ');
    console.log(
      `${index + 1}. [${verdict}] key=${group.key} :: ${names}`,
    );
    if (group.deniedReason) {
      console.log(`   판단: ${group.deniedReason}`);
    }
  });
}

async function main(): Promise<void> {
  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const { user, password } = neo4jCredentials();
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    printReport(await readConcepts(driver));
  } finally {
    await driver.close();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
