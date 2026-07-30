import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConceptDictionarySchema, type ConceptDictionary, type ConceptEntry, type ConceptKind } from "@devloop/shared";
import type { PipelineConfig } from "../config";
import { firstString, readRawProject } from "../raw-reader";

const TAG_KINDS: Record<string, ConceptKind> = {
  "0": "type",
  "1": "product",
  "2": "component",
};

const ENGLISH_TITLE_TOKEN = /[A-Za-z][A-Za-z0-9.&_-]+/g;

export interface ConceptSeedOptions {
  dataRoot: string;
  project: string;
  config?: PipelineConfig;
}

export interface ConceptSeedResult {
  outputPath: string;
  concepts: ConceptDictionary;
}

function inferKind(name: string, hint = ""): ConceptKind {
  const value = `${name} ${hint}`.toLowerCase();
  if (/(service|controller|interceptor|component|module|컴포넌트|모듈)/.test(value)) return "component";
  if (/(api|sdk|db|database|docker|kubernetes|kafka|redis|typescript|java|python|기술|플랫폼)/.test(value)) return "tech";
  if (/(product|제품|서비스)/.test(value)) return "product";
  return "type";
}

function aliasesFor(canonical: string, aliases: string[] = []): string[] {
  const dotAlias = canonical.includes(".") ? canonical.replaceAll(".", " ").replace(/\s+/g, " ").trim() : undefined;
  return [...new Set([...aliases, ...(dotAlias && dotAlias !== canonical ? [dotAlias] : [])])].sort();
}

function normalizeConceptName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function isDotPartAlias(canonical: string, alias: string): boolean {
  if (!canonical.includes(".")) return false;
  const normalizedAlias = normalizeConceptName(alias);
  return canonical.split(".").some((part) => normalizeConceptName(part) === normalizedAlias);
}

function removeConflictingAliases(entries: readonly ConceptEntry[]): ConceptEntry[] {
  const canonicalOwners = new Map<string, Set<string>>();
  const aliasOwners = new Map<string, Set<string>>();

  for (const entry of entries) {
    const canonicalName = normalizeConceptName(entry.canonical);
    const owners = canonicalOwners.get(canonicalName) ?? new Set<string>();
    owners.add(entry.canonical);
    canonicalOwners.set(canonicalName, owners);

    for (const alias of entry.aliases) {
      const aliasName = normalizeConceptName(alias);
      const aliases = aliasOwners.get(aliasName) ?? new Set<string>();
      aliases.add(entry.canonical);
      aliasOwners.set(aliasName, aliases);
    }
  }

  return entries.map((entry) => ({
    ...entry,
    aliases: entry.aliases.filter((alias) => {
      if (isDotPartAlias(entry.canonical, alias)) return false;
      const aliasName = normalizeConceptName(alias);
      const otherCanonical = [...(canonicalOwners.get(aliasName) ?? [])].some((canonical) => canonical !== entry.canonical);
      const sharedAlias = (aliasOwners.get(aliasName)?.size ?? 0) > 1;
      return !otherCanonical && !sharedAlias;
    }),
  }));
}

function titleConcepts(title: string): string[] {
  const matches = [...title.matchAll(ENGLISH_TITLE_TOKEN)].filter((match) => match[0].length >= 2);
  const concepts = new Set(matches.map((match) => match[0]));
  let phraseStart = 0;

  for (let index = 1; index <= matches.length; index += 1) {
    const previous = matches[index - 1];
    const current = matches[index];
    const separator = current ? title.slice((previous.index ?? 0) + previous[0].length, current.index) : undefined;
    if (separator !== undefined && /^\s+(?:&\s+)?$/.test(separator)) continue;
    if (index - phraseStart > 1) {
      const first = matches[phraseStart];
      concepts.add(title.slice(first.index, (previous.index ?? 0) + previous[0].length));
    }
    phraseStart = index;
  }

  return [...concepts];
}

function titlePrefix(subject: string): string | undefined {
  return subject.match(/^\[([^\]]+)\]/)?.[1]?.trim();
}

async function readExisting(outputPath: string): Promise<ConceptDictionary> {
  try {
    return ConceptDictionarySchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function mergeConcept(target: Map<string, ConceptEntry>, entry: ConceptEntry): void {
  const normalizedEntry = { ...entry, aliases: aliasesFor(entry.canonical, entry.aliases) };
  const existing = target.get(entry.canonical);
  if (!existing) {
    target.set(entry.canonical, normalizedEntry);
    return;
  }
  target.set(entry.canonical, {
    canonical: existing.canonical,
    kind: existing.kind,
    aliases: [...new Set([...existing.aliases, ...normalizedEntry.aliases])].sort(),
  });
}

function tagConcept(name: string): ConceptEntry {
  const match = name.match(/^([012]):\s*(.+)$/);
  const canonical = match?.[2]?.trim() ?? name;
  return {
    canonical,
    kind: match ? TAG_KINDS[match[1]] : inferKind(canonical),
    aliases: match ? [name] : [],
  };
}

export async function seedConcepts(options: ConceptSeedOptions): Promise<ConceptSeedResult> {
  const raw = await readRawProject(options.dataRoot, options.project);
  const outputPath = path.join(options.dataRoot, "concepts", `${options.project}.json`);
  const concepts = new Map<string, ConceptEntry>();
  const existingConcepts = await readExisting(outputPath);

  for (const name of Object.values(raw.tags)) {
    mergeConcept(concepts, tagConcept(name));
  }

  for (const document of raw.posts) {
    const subject = firstString(document.post, ["subject", "title"]);
    const prefix = subject ? titlePrefix(subject) : undefined;
    if (!prefix) continue;
    mergeConcept(concepts, {
      canonical: prefix,
      kind: "component",
      aliases: [],
    });
  }

  for (const wiki of raw.wikis) {
    const subject = firstString(wiki, ["subject", "title"]);
    if (!subject) continue;
    for (const concept of titleConcepts(subject)) {
      mergeConcept(concepts, { canonical: concept, kind: inferKind(concept, subject), aliases: [] });
    }
  }

  for (const existing of existingConcepts) {
    if (concepts.has(existing.canonical)) mergeConcept(concepts, existing);
  }

  const result = ConceptDictionarySchema.parse(
    removeConflictingAliases([...concepts.values()]).sort((left, right) => left.canonical.localeCompare(right.canonical)),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { outputPath, concepts: result };
}
