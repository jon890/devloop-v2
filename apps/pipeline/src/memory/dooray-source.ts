import { stat } from "node:fs/promises";
import path from "node:path";
import { MEMORY_SCHEMA_VERSION, sourceRefKey, type EvidencePacket, type SourceRef } from "@devloop/shared";
import { firstString, readRawProject, textContentPreservingLineBreaks } from "../raw-reader";
import { compareText, hashCanonical, packetWithContentHash } from "./evidence-serialization";

const DOORAY_BASE_URL = "https://nhnent.dooray.com/project";

export interface DooraySourceCounts {
  tasks: number;
  comments: number;
  wikis: number;
}

export interface DooraySourceResult {
  contentHash: string;
  counts: DooraySourceCounts;
  packets: EvidencePacket[];
}

function requireField(value: string | undefined, kind: string, location: string, field: string): string {
  if (value) return value;
  throw new Error(`Dooray ${kind} 원천 ${location}: 필수 ${field}가 없습니다.`);
}

function optionalOccurredAt(value: unknown): string | undefined {
  const candidate = firstString(value, ["createdAt", "createdDate", "updatedAt"]);
  if (!candidate) return undefined;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function taskUrl(taskId: string): string {
  return `${DOORAY_BASE_URL}/tasks/${encodeURIComponent(taskId)}`;
}

function wikiUrl(pageId: string): string {
  return `${DOORAY_BASE_URL}/pages/${encodeURIComponent(pageId)}`;
}

export async function normalizeDooraySource(dataDir: string, project: string): Promise<DooraySourceResult> {
  const raw = await readRawProject(dataDir, project);
  try {
    if (!(await stat(raw.projectDir)).isDirectory()) throw new Error("디렉터리가 아닙니다.");
  } catch (error) {
    throw new Error(`Dooray raw 원천 ${raw.projectDir}: 읽을 수 없습니다. ${(error as Error).message}`);
  }

  const packets: EvidencePacket[] = [];
  let commentCount = 0;

  for (const [postIndex, document] of raw.posts.entries()) {
    const location = path.join(raw.projectDir, "posts", `[${postIndex}]`);
    const taskId = requireField(firstString(document.post, ["id"]), "task", location, "post.id");
    const number = requireField(firstString(document.post, ["number"]), "task", location, "post.number");
    const text = requireField(textContentPreservingLineBreaks(document.post), "task", location, "본문");
    const title = firstString(document.post, ["subject", "title"]) ?? `Task ${number}`;
    const taskRef: SourceRef = {
      sourceType: "dooray-task",
      sourceId: taskId,
      url: taskUrl(taskId),
      title: `${number} ${title}`,
      ...(optionalOccurredAt(document.post) ? { occurredAt: optionalOccurredAt(document.post) } : {}),
    };

    const comments = document.comments
      .map((comment, index) => ({ comment, index, id: firstString(comment, ["id"]) }))
      .sort((left, right) => compareText(left.id ?? "", right.id ?? "") || left.index - right.index);
    const sourceRefs: SourceRef[] = [taskRef];
    const segments = [{ sourceRefKey: sourceRefKey(taskRef), text }];

    for (const { comment, index, id } of comments) {
      const commentLocation = `${location}/comments[${index}]`;
      const commentId = requireField(id, "comment", commentLocation, "comment.id");
      const commentText = requireField(textContentPreservingLineBreaks(comment), "comment", commentLocation, "본문");
      const commentRef: SourceRef = {
        sourceType: "dooray-comment",
        sourceId: commentId,
        parentId: taskId,
        url: taskUrl(taskId),
        title: `${number} 댓글 ${commentId}`,
        ...(optionalOccurredAt(comment) ? { occurredAt: optionalOccurredAt(comment) } : {}),
      };
      sourceRefs.push(commentRef);
      segments.push({ sourceRefKey: sourceRefKey(commentRef), text: commentText });
      commentCount += 1;
    }

    packets.push(
      packetWithContentHash({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        id: `dooray-task:${taskId}`,
        project,
        sourceKind: "dooray-task",
        title,
        scope: { project, repositories: [], paths: [] },
        segments,
        sourceRefs,
      }),
    );
  }

  for (const [wikiIndex, wiki] of raw.wikis.entries()) {
    const location = path.join(raw.projectDir, "wiki", `[${wikiIndex}]`);
    const pageId = requireField(firstString(wiki, ["pageId", "id"]), "wiki", location, "pageId/id");
    const text = requireField(textContentPreservingLineBreaks(wiki), "wiki", location, "본문");
    const title = firstString(wiki, ["subject", "title"]) ?? `Wiki ${pageId}`;
    const ref: SourceRef = {
      sourceType: "dooray-wiki",
      sourceId: pageId,
      url: wikiUrl(pageId),
      title,
      ...(optionalOccurredAt(wiki) ? { occurredAt: optionalOccurredAt(wiki) } : {}),
    };
    packets.push(
      packetWithContentHash({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        id: `dooray-wiki:${pageId}`,
        project,
        sourceKind: "dooray-wiki",
        title,
        scope: { project, repositories: [], paths: [] },
        segments: [{ sourceRefKey: sourceRefKey(ref), text }],
        sourceRefs: [ref],
      }),
    );
  }

  packets.sort((left, right) => compareText(left.id, right.id));
  const counts = { tasks: raw.posts.length, comments: commentCount, wikis: raw.wikis.length };
  return { contentHash: hashCanonical({ counts, packets }), counts, packets };
}
