import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ConceptKind,
  OntologyNode,
  OntologyRelationship,
  RawDoorayObject,
} from '@devloop/shared';
import { GraphRecordSchema, nodeRef, type GraphRecord } from './graph-record';
import {
  asRecordArray,
  firstString,
  readRawProject,
  textContent,
  valueAt,
} from './raw-reader';

const TASK_REFERENCE_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9_-]*)\/(\d+)\b/g;
const CODE_REFERENCE_PATTERN = /\b\w+(?:Service|Controller|Interceptor|Component):\d+\b/g;

export interface StructuralExtractionOptions {
  dataRoot: string;
  project: string;
}

export interface StructuralExtractionResult {
  outputPath: string;
  nodes: number;
  relationships: number;
  records: GraphRecord[];
}

function addNode(store: Map<string, OntologyNode>, node: OntologyNode): void {
  const parsed = GraphRecordSchema.parse(node) as OntologyNode;
  const identity = nodeRef(parsed.label, parsed.key);
  const previous = store.get(identity);
  store.set(identity, previous ? { ...previous, properties: { ...previous.properties, ...parsed.properties } } : parsed);
}

function addRelationship(store: Map<string, OntologyRelationship>, relationship: OntologyRelationship): void {
  const parsed = GraphRecordSchema.parse(relationship) as OntologyRelationship;
  const identity = [parsed.type, parsed.startKey, parsed.endKey, JSON.stringify(parsed.properties)].join('|');
  store.set(identity, parsed);
}

function memberIdentity(value: unknown): string | undefined {
  return firstString(value, ['member.id', 'memberId', 'id', 'user.id', 'user.memberId']);
}

function memberName(value: unknown): string | undefined {
  return firstString(value, ['member.name', 'name', 'user.name']);
}

function postAuthor(post: RawDoorayObject): Record<string, unknown> | undefined {
  const candidates = [
    valueAt(post, 'users.from'),
    valueAt(post, 'from'),
    valueAt(post, 'creator'),
    valueAt(post, 'author'),
    valueAt(post, 'user'),
  ];
  return candidates.find(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate),
  );
}

function assignees(post: RawDoorayObject): Array<{ value: Record<string, unknown>; role: 'to' | 'cc' }> {
  return [
    ...asRecordArray(valueAt(post, 'users.to')).map((value) => ({ value, role: 'to' as const })),
    ...asRecordArray(valueAt(post, 'users.cc')).map((value) => ({ value, role: 'cc' as const })),
    ...asRecordArray(valueAt(post, 'to')).map((value) => ({ value, role: 'to' as const })),
    ...asRecordArray(valueAt(post, 'cc')).map((value) => ({ value, role: 'cc' as const })),
  ];
}

function tagEntries(post: RawDoorayObject): Array<{ id?: string; name?: string; dimension: string }> {
  const rawTags = valueAt(post, 'tags') ?? valueAt(post, 'tagIds');
  if (!Array.isArray(rawTags)) return [];
  const result: Array<{ id?: string; name?: string; dimension: string }> = [];
  for (const tag of rawTags) {
    if (typeof tag === 'string' || typeof tag === 'number') {
      result.push({ id: String(tag), dimension: 'unknown' });
      continue;
    }
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) continue;
    result.push({
      id: firstString(tag, ['id', 'tagId']),
      name: firstString(tag, ['name', 'tagName']),
      dimension: firstString(tag, ['dimension', 'groupName', 'tagGroupName', 'group.name']) ?? 'unknown',
    });
  }
  return result;
}

function tagKind(dimension: string): ConceptKind {
  const normalized = dimension.toLowerCase();
  if (/(component|컴포넌트|module|모듈)/.test(normalized)) return 'component';
  if (/(product|제품|서비스)/.test(normalized)) return 'product';
  if (/(tech|기술|platform|플랫폼)/.test(normalized)) return 'tech';
  return 'type';
}

function parentTaskNumber(post: RawDoorayObject): string | undefined {
  return firstString(post, [
    'parentPost.number',
    'parent.number',
    'parentPostNumber',
    'parentNumber',
  ]);
}

function addTextReferences(
  text: string,
  sourceLabel: 'Task' | 'Wiki',
  sourceKey: string,
  nodes: Map<string, OntologyNode>,
  relationships: Map<string, OntologyRelationship>,
): void {
  for (const match of text.matchAll(TASK_REFERENCE_PATTERN)) {
    if (sourceLabel !== 'Task') continue;
    addRelationship(relationships, {
      type: 'REFERENCES',
      startKey: nodeRef('Task', sourceKey),
      endKey: nodeRef('Task', match[2]),
      properties: { project: match[1] },
    });
  }
  for (const match of text.matchAll(CODE_REFERENCE_PATTERN)) {
    addNode(nodes, {
      label: 'Concept',
      key: match[0],
      properties: { name: match[0], kind: 'code-ref' },
    });
  }
}

export async function extractStructural(options: StructuralExtractionOptions): Promise<StructuralExtractionResult> {
  const raw = await readRawProject(options.dataRoot, options.project);
  const nodes = new Map<string, OntologyNode>();
  const relationships = new Map<string, OntologyRelationship>();

  addNode(nodes, {
    label: 'Project',
    key: options.project,
    properties: { code: options.project, name: options.project },
  });

  for (const [memberId, name] of Object.entries(raw.members)) {
    addNode(nodes, { label: 'Person', key: memberId, properties: { memberId, name } });
  }
  for (const name of Object.values(raw.tags)) {
    addNode(nodes, { label: 'Concept', key: name, properties: { name, kind: 'type' } });
  }

  for (const document of raw.posts) {
    const post = document.post;
    const number = firstString(post, ['number', 'postNumber', 'id']);
    if (!number) throw new Error('Raw post is missing number/postNumber/id.');
    const subject = firstString(post, ['subject', 'title']) ?? `Task ${number}`;
    addNode(nodes, {
      label: 'Task',
      key: number,
      properties: {
        number,
        subject,
        workflowClass: firstString(post, ['workflowClass', 'workflowClass.name', 'status']),
        createdAt: firstString(post, ['createdAt', 'createdDate']),
        url: firstString(post, ['url', 'webUrl']),
      },
    });
    addRelationship(relationships, {
      type: 'CONTAINS',
      startKey: nodeRef('Project', options.project),
      endKey: nodeRef('Task', number),
      properties: {},
    });

    const author = postAuthor(post);
    const authorId = author ? memberIdentity(author) : undefined;
    if (authorId) {
      addNode(nodes, {
        label: 'Person',
        key: authorId,
        properties: { memberId: authorId, name: memberName(author) ?? raw.members[authorId] ?? authorId },
      });
      addRelationship(relationships, {
        type: 'AUTHORED',
        startKey: nodeRef('Person', authorId),
        endKey: nodeRef('Task', number),
        properties: {},
      });
    }

    for (const assignee of assignees(post)) {
      const memberId = memberIdentity(assignee.value);
      if (!memberId) continue;
      addNode(nodes, {
        label: 'Person',
        key: memberId,
        properties: { memberId, name: memberName(assignee.value) ?? raw.members[memberId] ?? memberId },
      });
      addRelationship(relationships, {
        type: 'ASSIGNED_TO',
        startKey: nodeRef('Task', number),
        endKey: nodeRef('Person', memberId),
        properties: { role: assignee.role },
      });
    }

    for (const tag of tagEntries(post)) {
      const name = tag.name ?? (tag.id ? raw.tags[tag.id] : undefined);
      if (!name) continue;
      addNode(nodes, { label: 'Concept', key: name, properties: { name, kind: tagKind(tag.dimension) } });
      addRelationship(relationships, {
        type: 'TAGGED',
        startKey: nodeRef('Task', number),
        endKey: nodeRef('Concept', name),
        properties: { dimension: tag.dimension },
      });
    }

    const parentNumber = parentTaskNumber(post);
    if (parentNumber) {
      addRelationship(relationships, {
        type: 'CHILD_OF',
        startKey: nodeRef('Task', number),
        endKey: nodeRef('Task', parentNumber),
        properties: {},
      });
    }

    addTextReferences(textContent(post), 'Task', number, nodes, relationships);
    for (const [index, comment] of document.comments.entries()) {
      const commentId = firstString(comment, ['commentId', 'id']) ?? `${number}-${index + 1}`;
      const commentText = textContent(comment);
      addNode(nodes, {
        label: 'Comment',
        key: commentId,
        properties: {
          commentId,
          createdAt: firstString(comment, ['createdAt', 'createdDate']),
          excerpt: commentText.slice(0, 200),
        },
      });
      addRelationship(relationships, {
        type: 'HAS_COMMENT',
        startKey: nodeRef('Task', number),
        endKey: nodeRef('Comment', commentId),
        properties: {},
      });
      const commenter = postAuthor(comment);
      const commenterId = commenter ? memberIdentity(commenter) : undefined;
      if (commenterId) {
        addNode(nodes, {
          label: 'Person',
          key: commenterId,
          properties: { memberId: commenterId, name: memberName(commenter) ?? raw.members[commenterId] ?? commenterId },
        });
        addRelationship(relationships, {
          type: 'COMMENTED',
          startKey: nodeRef('Person', commenterId),
          endKey: nodeRef('Comment', commentId),
          properties: {},
        });
      }
      addTextReferences(commentText, 'Task', number, nodes, relationships);
    }
  }

  for (const wiki of raw.wikis) {
    const pageId = firstString(wiki, ['pageId', 'id']);
    if (!pageId) throw new Error('Raw wiki page is missing pageId/id.');
    const subject = firstString(wiki, ['subject', 'title']) ?? `Wiki ${pageId}`;
    const parentId = firstString(wiki, ['parentId', 'parent.pageId', 'parent.id']);
    addNode(nodes, {
      label: 'Wiki',
      key: pageId,
      properties: { pageId, subject, parentId },
    });
    addRelationship(relationships, {
      type: 'CONTAINS',
      startKey: nodeRef('Project', options.project),
      endKey: nodeRef('Wiki', pageId),
      properties: {},
    });
    addTextReferences(textContent(wiki), 'Wiki', pageId, nodes, relationships);
  }

  const records: GraphRecord[] = [...nodes.values(), ...relationships.values()];
  const outputDir = path.join(options.dataRoot, 'graph', options.project);
  const outputPath = path.join(outputDir, 'structural.jsonl');
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return { outputPath, nodes: nodes.size, relationships: relationships.size, records };
}
