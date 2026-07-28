import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { STRUCTURAL_GRAPH_FILE } from "@devloop/shared";
import type { ConceptKind, OntologyNode, OntologyRelationship, RawDoorayObject } from "@devloop/shared";
import { GraphRecordSchema, nodeRef, type GraphRecord } from "./graph-record.schema";
import { CODE_REFERENCE_PATTERN, TAG_DIMENSION_PATTERN } from "./structural-extractor.const";
import { findTaskReferences } from "./task-reference";
import { asRecordArray, firstString, readRawProject, textContent, valueAt } from "./raw-reader";

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

type RawProject = Awaited<ReturnType<typeof readRawProject>>;

interface StructuralGraphStores {
  nodes: Map<string, OntologyNode>;
  relationships: Map<string, OntologyRelationship>;
  wikiParents: Array<{ pageId: string; parentId: string }>;
}

function addNode(store: Map<string, OntologyNode>, node: OntologyNode): void {
  const parsed = GraphRecordSchema.parse(node) as OntologyNode;
  const identity = nodeRef(parsed.label, parsed.key);
  const previous = store.get(identity);
  store.set(identity, previous ? { ...previous, properties: { ...previous.properties, ...parsed.properties } } : parsed);
}

function addRelationship(store: Map<string, OntologyRelationship>, relationship: OntologyRelationship): void {
  const parsed = GraphRecordSchema.parse(relationship) as OntologyRelationship;
  const identity = [parsed.type, parsed.startKey, parsed.endKey, JSON.stringify(parsed.properties)].join("|");
  store.set(identity, parsed);
}

function memberIdentity(value: unknown): string | undefined {
  return firstString(value, ["member.organizationMemberId", "organizationMemberId", "member.id", "memberId", "id", "user.id", "user.memberId"]);
}

function taskNumber(post: RawDoorayObject): number {
  const rawNumber = valueAt(post, "number") ?? valueAt(post, "postNumber");
  const number = typeof rawNumber === "number" ? rawNumber : Number(rawNumber);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Raw post is missing an integer number/postNumber.");
  }
  return number;
}

function taskBodyExcerpt(post: RawDoorayObject): string {
  for (const candidatePath of ["body.content", "body.text", "content", "text", "description"]) {
    const candidate = valueAt(post, candidatePath);
    if (typeof candidate === "string") return candidate.slice(0, 300);
  }
  return "";
}

function postAuthor(post: RawDoorayObject): Record<string, unknown> | undefined {
  const candidates = [valueAt(post, "users.from"), valueAt(post, "from"), valueAt(post, "creator"), valueAt(post, "author"), valueAt(post, "user")];
  return candidates.find(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate),
  );
}

function assignees(post: RawDoorayObject): Array<{ value: Record<string, unknown>; role: "to" | "cc" }> {
  return [
    ...asRecordArray(valueAt(post, "users.to")).map((value) => ({ value, role: "to" as const })),
    ...asRecordArray(valueAt(post, "users.cc")).map((value) => ({ value, role: "cc" as const })),
    ...asRecordArray(valueAt(post, "to")).map((value) => ({ value, role: "to" as const })),
    ...asRecordArray(valueAt(post, "cc")).map((value) => ({ value, role: "cc" as const })),
  ];
}

function tagEntries(post: RawDoorayObject): Array<{ id?: string; name?: string; dimension: string }> {
  const rawTags = valueAt(post, "tags") ?? valueAt(post, "tagIds");
  if (!Array.isArray(rawTags)) return [];
  const result: Array<{ id?: string; name?: string; dimension: string }> = [];
  for (const tag of rawTags) {
    if (typeof tag === "string" || typeof tag === "number") {
      result.push({ id: String(tag), dimension: "unknown" });
      continue;
    }
    if (!tag || typeof tag !== "object" || Array.isArray(tag)) continue;
    result.push({
      id: firstString(tag, ["id", "tagId"]),
      name: firstString(tag, ["name", "tagName"]),
      dimension: firstString(tag, ["dimension", "groupName", "tagGroupName", "group.name"]) ?? "unknown",
    });
  }
  return result;
}

function tagKind(dimension: string): ConceptKind {
  if (dimension === "0") return "type";
  if (dimension === "1") return "product";
  if (dimension === "2") return "component";
  const normalized = dimension.toLowerCase();
  if (/(component|컴포넌트|module|모듈)/.test(normalized)) return "component";
  if (/(product|제품|서비스)/.test(normalized)) return "product";
  if (/(tech|기술|platform|플랫폼)/.test(normalized)) return "tech";
  return "type";
}

function tagDimension(name: string, fallback: string): string {
  return name.match(TAG_DIMENSION_PATTERN)?.[1] ?? fallback;
}

function parentTaskNumber(post: RawDoorayObject): string | undefined {
  return firstString(post, ["parentPost.number", "parent.number", "parentPostNumber", "parentNumber"]);
}

function addTextReferences(
  project: string,
  text: string,
  sourceLabel: "Task" | "Wiki",
  sourceKey: string,
  nodes: Map<string, OntologyNode>,
  relationships: Map<string, OntologyRelationship>,
): void {
  if (sourceLabel === "Task") {
    for (const reference of findTaskReferences(text, sourceKey, project)) {
      addRelationship(relationships, {
        type: "REFERENCES",
        startKey: nodeRef("Task", sourceKey),
        endKey: nodeRef("Task", reference.number),
        properties: { project: reference.project },
      });
    }
  }
  for (const match of text.matchAll(CODE_REFERENCE_PATTERN)) {
    addNode(nodes, {
      label: "Concept",
      key: match[0],
      properties: { name: match[0], kind: "code-ref" },
    });
  }
}

function createStores(): StructuralGraphStores {
  return {
    nodes: new Map<string, OntologyNode>(),
    relationships: new Map<string, OntologyRelationship>(),
    wikiParents: [],
  };
}

function addProject(project: string, stores: StructuralGraphStores): void {
  addNode(stores.nodes, {
    label: "Project",
    key: project,
    properties: { code: project, name: project },
  });
}

function addMembers(members: RawProject["members"], stores: StructuralGraphStores): void {
  for (const [memberId, name] of Object.entries(members)) {
    addNode(stores.nodes, { label: "Person", key: memberId, properties: { memberId, name } });
  }
}

function addTags(tags: RawProject["tags"], stores: StructuralGraphStores): void {
  for (const name of Object.values(tags)) {
    addNode(stores.nodes, { label: "Concept", key: name, properties: { name, kind: "type" } });
  }
}

function addPostDocument(
  project: string,
  members: RawProject["members"],
  tags: RawProject["tags"],
  document: RawProject["posts"][number],
  stores: StructuralGraphStores,
): void {
  const post = document.post;
  const numericNumber = taskNumber(post);
  const number = String(numericNumber);
  addTaskNode(post, number, numericNumber, stores);
  addRelationship(stores.relationships, {
    type: "CONTAINS",
    startKey: nodeRef("Project", project),
    endKey: nodeRef("Task", number),
    properties: {},
  });

  addAuthor(post, number, members, stores);
  addAssignees(post, number, members, stores);
  addPostTags(post, number, tags, stores);
  addParentTask(post, number, stores);
  addTextReferences(project, textContent(post), "Task", number, stores.nodes, stores.relationships);
  addComments(project, document, number, members, stores);
}

function addTaskNode(post: RawDoorayObject, number: string, numericNumber: number, stores: StructuralGraphStores): void {
  const subject = firstString(post, ["subject", "title"]) ?? `Task ${number}`;
  addNode(stores.nodes, {
    label: "Task",
    key: number,
    properties: {
      number: numericNumber,
      subject,
      workflowClass: firstString(post, ["workflowClass", "workflowClass.name", "status"]),
      createdAt: firstString(post, ["createdAt", "createdDate"]),
      url: firstString(post, ["url", "webUrl"]),
      bodyExcerpt: taskBodyExcerpt(post),
    },
  });
}

function addAuthor(post: RawDoorayObject, number: string, members: RawProject["members"], stores: StructuralGraphStores): void {
  const author = postAuthor(post);
  const authorId = author ? memberIdentity(author) : undefined;
  if (!authorId) return;
  addPerson(authorId, members, stores);
  addRelationship(stores.relationships, {
    type: "AUTHORED",
    startKey: nodeRef("Person", authorId),
    endKey: nodeRef("Task", number),
    properties: {},
  });
}

function addPerson(memberId: string, members: RawProject["members"], stores: StructuralGraphStores): void {
  addNode(stores.nodes, {
    label: "Person",
    key: memberId,
    properties: { memberId, name: members[memberId] ?? memberId },
  });
}

function addAssignees(post: RawDoorayObject, number: string, members: RawProject["members"], stores: StructuralGraphStores): void {
  for (const assignee of assignees(post)) {
    const memberId = memberIdentity(assignee.value);
    if (!memberId) continue;
    addPerson(memberId, members, stores);
    addRelationship(stores.relationships, {
      type: "ASSIGNED_TO",
      startKey: nodeRef("Task", number),
      endKey: nodeRef("Person", memberId),
      properties: { role: assignee.role },
    });
  }
}

function addPostTags(post: RawDoorayObject, number: string, tags: RawProject["tags"], stores: StructuralGraphStores): void {
  for (const tag of tagEntries(post)) {
    const name = tag.name ?? (tag.id ? tags[tag.id] : undefined);
    if (!name) continue;
    const dimension = tagDimension(name, tag.dimension);
    addNode(stores.nodes, { label: "Concept", key: name, properties: { name, kind: tagKind(dimension) } });
    addRelationship(stores.relationships, {
      type: "TAGGED",
      startKey: nodeRef("Task", number),
      endKey: nodeRef("Concept", name),
      properties: { dimension },
    });
  }
}

function addParentTask(post: RawDoorayObject, number: string, stores: StructuralGraphStores): void {
  const parentNumber = parentTaskNumber(post);
  if (!parentNumber) return;
  addRelationship(stores.relationships, {
    type: "CHILD_OF",
    startKey: nodeRef("Task", number),
    endKey: nodeRef("Task", parentNumber),
    properties: {},
  });
}

function addComments(
  project: string,
  document: RawProject["posts"][number],
  number: string,
  members: RawProject["members"],
  stores: StructuralGraphStores,
): void {
  for (const [index, comment] of document.comments.entries()) {
    const commentId = firstString(comment, ["commentId", "id"]) ?? `${number}-${index + 1}`;
    const commentText = textContent(comment);
    addCommentNode(comment, commentId, commentText, stores);
    addRelationship(stores.relationships, {
      type: "HAS_COMMENT",
      startKey: nodeRef("Task", number),
      endKey: nodeRef("Comment", commentId),
      properties: {},
    });
    addCommenter(comment, commentId, members, stores);
    addTextReferences(project, commentText, "Task", number, stores.nodes, stores.relationships);
  }
}

function addCommentNode(comment: RawDoorayObject, commentId: string, commentText: string, stores: StructuralGraphStores): void {
  addNode(stores.nodes, {
    label: "Comment",
    key: commentId,
    properties: {
      commentId,
      createdAt: firstString(comment, ["createdAt", "createdDate"]),
      excerpt: commentText.slice(0, 200),
    },
  });
}

function addCommenter(comment: RawDoorayObject, commentId: string, members: RawProject["members"], stores: StructuralGraphStores): void {
  const commenter = postAuthor(comment);
  const commenterId = commenter ? memberIdentity(commenter) : undefined;
  if (!commenterId) return;
  addPerson(commenterId, members, stores);
  addRelationship(stores.relationships, {
    type: "COMMENTED",
    startKey: nodeRef("Person", commenterId),
    endKey: nodeRef("Comment", commentId),
    properties: {},
  });
}

function addWikiPage(project: string, wiki: RawProject["wikis"][number], stores: StructuralGraphStores): void {
  const pageId = firstString(wiki, ["pageId", "id"]);
  if (!pageId) throw new Error("Raw wiki page is missing pageId/id.");
  const subject = firstString(wiki, ["subject", "title"]) ?? `Wiki ${pageId}`;
  const parentId = firstString(wiki, ["parentId", "parentPageId", "parent.pageId", "parent.id"]);
  addNode(stores.nodes, {
    label: "Wiki",
    key: pageId,
    properties: { pageId, subject, parentId },
  });
  addRelationship(stores.relationships, {
    type: "CONTAINS",
    startKey: nodeRef("Project", project),
    endKey: nodeRef("Wiki", pageId),
    properties: {},
  });
  if (parentId) stores.wikiParents.push({ pageId, parentId });
  addTextReferences(project, textContent(wiki), "Wiki", pageId, stores.nodes, stores.relationships);
}

function addWikiParentRelationships(stores: StructuralGraphStores): void {
  for (const { pageId, parentId } of stores.wikiParents) {
    if (!stores.nodes.has(nodeRef("Wiki", parentId))) continue;
    addRelationship(stores.relationships, {
      type: "CHILD_OF",
      startKey: nodeRef("Wiki", pageId),
      endKey: nodeRef("Wiki", parentId),
      properties: {},
    });
  }
}

function graphRecords(stores: StructuralGraphStores): {
  resolvedRelationships: OntologyRelationship[];
  records: GraphRecord[];
} {
  const resolvedRelationships = [...stores.relationships.values()].filter(
    (relationship) => relationship.type !== "REFERENCES" || (stores.nodes.has(relationship.startKey) && stores.nodes.has(relationship.endKey)),
  );
  return {
    resolvedRelationships,
    records: [...stores.nodes.values(), ...resolvedRelationships],
  };
}

export async function extractStructural(options: StructuralExtractionOptions): Promise<StructuralExtractionResult> {
  const raw = await readRawProject(options.dataRoot, options.project);
  const stores = createStores();
  addProject(options.project, stores);
  addMembers(raw.members, stores);
  addTags(raw.tags, stores);
  for (const document of raw.posts) {
    addPostDocument(options.project, raw.members, raw.tags, document, stores);
  }
  for (const wiki of raw.wikis) {
    addWikiPage(options.project, wiki, stores);
  }
  addWikiParentRelationships(stores);

  const { resolvedRelationships, records } = graphRecords(stores);
  const outputDir = path.join(options.dataRoot, "graph", options.project);
  const outputPath = path.join(outputDir, STRUCTURAL_GRAPH_FILE);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return { outputPath, nodes: stores.nodes.size, relationships: resolvedRelationships.length, records };
}
