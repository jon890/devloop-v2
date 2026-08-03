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

/**
 * `textContent` 와 같은 원천에서 텍스트를 뽑되 **개행을 남긴다.** 줄 안의 공백·탭만 병합한다.
 *
 * 그래프에 저장해 답변이 인용할 텍스트에 쓴다. `textContent` 는 `\s+` 를 공백 하나로 바꿔
 * 개행을 지우는데, 200자만 저장할 때는 문제가 없었지만 6,000자를 담으면 마크다운 표·목록·헤딩이
 * 통째로 뭉개진다. 표의 행 경계가 사라지면 값을 다른 행에서 잘못 읽어 답이 틀릴 수 있다.
 *
 * **참조 추출에는 쓰지 마라.** `addTextReferences` 는 `textContent` 값을 그대로 받아야 한다.
 * 가공한 값을 넘기면 `REFERENCES` 328건이 조용히 바뀐다.
 */
export function textContentPreservingLineBreaks(value: unknown): string {
  const content = firstString(value, ["body.content", "body.text", "content", "text", "description"]);
  if (!content) return "";
  return (
    content
      .replace(/<[^>]+>/g, " ")
      .replace(/\r\n?/g, "\n")
      // 개행이 아닌 공백만 병합한다. `\s` 는 개행을 포함하므로 쓸 수 없다.
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim()
  );
}
