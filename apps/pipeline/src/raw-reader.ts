import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  RawNameMapSchema,
  RawPostDocumentSchema,
  RawWikiPageSchema,
  type RawDoorayObject,
  type RawNameMap,
  type RawPostDocument,
} from "@devloop/shared";

export interface RawProjectData {
  project: string;
  projectDir: string;
  tags: RawNameMap;
  members: RawNameMap;
  posts: RawPostDocument[];
  wikis: RawDoorayObject[];
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readOptionalNameMap(filePath: string): Promise<RawNameMap> {
  try {
    return RawNameMapSchema.parse(await readJson(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function readJsonDirectory<T>(directory: string, parse: (value: unknown) => T): Promise<T[]> {
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(entries.map(async (entry) => parse(await readJson(path.join(directory, entry)))));
}

export async function readRawProject(dataRoot: string, project: string): Promise<RawProjectData> {
  const projectDir = path.join(dataRoot, "raw", project);
  const [tags, members, posts, wikis] = await Promise.all([
    readOptionalNameMap(path.join(projectDir, "tags.json")),
    readOptionalNameMap(path.join(projectDir, "members.json")),
    readJsonDirectory(path.join(projectDir, "posts"), (value) => RawPostDocumentSchema.parse(value)),
    readJsonDirectory(path.join(projectDir, "wiki"), (value) => RawWikiPageSchema.parse(value)),
  ]);

  return { project, projectDir, tags, members, posts, wikis };
}

export function valueAt(value: unknown, pathExpression: string): unknown {
  return pathExpression.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function firstString(value: unknown, paths: readonly string[]): string | undefined {
  for (const candidatePath of paths) {
    const candidate = valueAt(value, candidatePath);
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return undefined;
}

export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

export function textContent(value: unknown): string {
  const content = firstString(value, ["body.content", "body.text", "content", "text", "description"]);
  return content
    ? content
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}
