import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConceptDictionarySchema, normalizeConceptKey, type ConceptDictionary, type ConceptEntry, type ConceptKind } from "@devloop/shared";
import type { PipelineConfig } from "../config";
import { composeConceptDictionary, readConceptCuration, type ConceptCuration } from "./dictionary";
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
  curation?: ConceptCuration;
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

export function removeConflictingAliases(
  entries: readonly ConceptEntry[],
  preservedAliasOwners: ReadonlyMap<string, string> = new Map(),
): ConceptEntry[] {
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
      const preservedOwner = preservedAliasOwners.get(normalizeConceptKey(alias));
      if (preservedOwner === normalizeConceptKey(entry.canonical)) return true;
      if (preservedOwner) return false;
      if (isDotPartAlias(entry.canonical, alias)) return false;
      const aliasName = normalizeConceptName(alias);
      const otherCanonical = [...(canonicalOwners.get(aliasName) ?? [])].some((canonical) => canonical !== entry.canonical);
      const sharedAlias = (aliasOwners.get(aliasName)?.size ?? 0) > 1;
      return !otherCanonical && !sharedAlias;
    }),
  }));
}

function titleConcepts(title: string, suppressedCanonicalKeys: ReadonlySet<string> = new Set()): string[] {
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

  return [...concepts].filter((concept) => !suppressedCanonicalKeys.has(normalizeConceptKey(concept)));
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

function compareCanonicalCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

interface ConceptWinner {
  canonical: string;
  kind: ConceptKind;
}

function canonicalWinners(
  existingConcepts: readonly ConceptEntry[],
  generatedConcepts: readonly ConceptEntry[],
  blockedConceptKeys: ReadonlySet<string>,
): Map<string, ConceptWinner> {
  const winners = new Map<string, ConceptWinner>();

  // Existing entries win. Without one, code-point order of canonical and kind
  // makes a fresh seed deterministic regardless of raw source traversal order.
  for (const entries of [existingConcepts, generatedConcepts]) {
    for (const entry of [...entries].sort(
      (left, right) => compareCanonicalCodePoint(left.canonical, right.canonical) || compareCanonicalCodePoint(left.kind, right.kind),
    )) {
      const conceptKey = normalizeConceptKey(entry.canonical);
      if (!conceptKey || blockedConceptKeys.has(conceptKey) || winners.has(conceptKey)) continue;
      winners.set(conceptKey, { canonical: entry.canonical, kind: entry.kind });
    }
  }

  return winners;
}

function preferWinner(entry: ConceptEntry, winnerByKey: ReadonlyMap<string, ConceptWinner>, blockedConceptKeys: ReadonlySet<string>): ConceptEntry {
  const conceptKey = normalizeConceptKey(entry.canonical);
  if (!conceptKey || blockedConceptKeys.has(conceptKey)) return entry;
  const winner = winnerByKey.get(conceptKey);
  return winner ? { ...entry, canonical: winner.canonical, kind: winner.kind } : entry;
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
  const curation = options.curation ?? (await readConceptCuration(requireSeedConfig(options.config), options.project, "seed-concepts"));
  const blockedConceptKeys = new Set(curation.blocks.map((block) => normalizeConceptKey(block.key)).filter(Boolean));
  const judgedAliasOwners = judgedAliasOwnerMap(curation);
  const judgedAliasKeys = new Set(judgedAliasOwners.keys());
  const decisionCount = curation.merges.reduce((sum, merge) => sum + merge.aliases.length, 0) + curation.blocks.length;
  const generatedConcepts: ConceptEntry[] = [];
  console.log(`판단 ${decisionCount}건 적용`);

  for (const name of Object.values(raw.tags)) {
    generatedConcepts.push(tagConcept(name));
  }

  for (const document of raw.posts) {
    const subject = firstString(document.post, ["subject", "title"]);
    const prefix = subject ? titlePrefix(subject) : undefined;
    if (!prefix) continue;
    generatedConcepts.push({
      canonical: prefix,
      kind: "component",
      aliases: [],
    });
  }

  for (const wiki of raw.wikis) {
    const subject = firstString(wiki, ["subject", "title"]);
    if (!subject) continue;
    for (const concept of titleConcepts(subject, judgedAliasKeys)) {
      generatedConcepts.push({ canonical: concept, kind: inferKind(concept, subject), aliases: [] });
    }
  }

  const winnerByKey = canonicalWinners(existingConcepts, generatedConcepts, blockedConceptKeys);
  for (const generated of generatedConcepts) {
    mergeConcept(concepts, preferWinner(generated, winnerByKey, blockedConceptKeys));
  }

  for (const existing of existingConcepts) {
    mergeConcept(concepts, preferWinner(existing, winnerByKey, blockedConceptKeys));
  }

  const withoutConflicts = removeConflictingAliases([...concepts.values()], judgedAliasOwners).sort((left, right) =>
    left.canonical.localeCompare(right.canonical),
  );
  const result = ConceptDictionarySchema.parse(
    composeConceptDictionary(withoutConflicts, curation, { fallbackKind: (canonical) => inferKind(canonical) }).dictionary,
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { outputPath, concepts: result };
}

function requireSeedConfig(config: PipelineConfig | undefined): PipelineConfig {
  if (!config) {
    throw new Error("seed-concepts requires pipeline config unless explicit curation is provided.");
  }
  return config;
}

function judgedAliasOwnerMap(curation: ConceptCuration): Map<string, string> {
  return new Map(
    curation.merges.flatMap((merge) => {
      const canonicalKey = normalizeConceptKey(merge.canonical);
      return merge.aliases.map((alias) => [normalizeConceptKey(alias), canonicalKey] as const);
    }),
  );
}
