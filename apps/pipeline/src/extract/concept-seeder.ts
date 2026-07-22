import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ConceptDictionarySchema,
  type ConceptDictionary,
  type ConceptEntry,
  type ConceptKind,
} from '@devloop/shared';
import { firstString, readRawProject } from './raw-reader';

const TITLE_STOP_WORDS = new Set([
  '가이드',
  '관련',
  '문서',
  '방법',
  '정리',
  '정책',
  '회의',
  '회의록',
  '용어',
  '작업',
  '정보',
  '페이지',
]);

export interface ConceptSeedOptions {
  dataRoot: string;
  project: string;
}

export interface ConceptSeedResult {
  outputPath: string;
  concepts: ConceptDictionary;
}

function inferKind(name: string, hint = ''): ConceptKind {
  const value = `${name} ${hint}`.toLowerCase();
  if (/(service|controller|interceptor|component|module|컴포넌트|모듈)/.test(value)) return 'component';
  if (/(api|sdk|db|database|docker|kubernetes|kafka|redis|typescript|java|python|기술|플랫폼)/.test(value)) return 'tech';
  if (/(product|제품|서비스)/.test(value)) return 'product';
  return 'type';
}

function titleNouns(title: string): string[] {
  return (title.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [])
    .map((token) => token.replace(/^(?:the|a|an)$/i, '').trim())
    .filter((token) => token.length >= 2 && !TITLE_STOP_WORDS.has(token));
}

function titlePrefix(subject: string): string | undefined {
  return subject.match(/^\[([^\]]+)\]/)?.[1]?.trim();
}

async function readExisting(outputPath: string): Promise<ConceptDictionary> {
  try {
    return ConceptDictionarySchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function mergeConcept(target: Map<string, ConceptEntry>, entry: ConceptEntry): void {
  const existing = target.get(entry.canonical);
  if (!existing) {
    target.set(entry.canonical, entry);
    return;
  }
  target.set(entry.canonical, {
    canonical: existing.canonical,
    kind: existing.kind,
    aliases: [...new Set([...existing.aliases, ...entry.aliases])].sort(),
  });
}

export async function seedConcepts(options: ConceptSeedOptions): Promise<ConceptSeedResult> {
  const raw = await readRawProject(options.dataRoot, options.project);
  const outputPath = path.join(options.dataRoot, 'concepts', `${options.project}.json`);
  const concepts = new Map<string, ConceptEntry>();

  for (const existing of await readExisting(outputPath)) mergeConcept(concepts, existing);

  for (const name of Object.values(raw.tags)) {
    mergeConcept(concepts, { canonical: name, kind: inferKind(name), aliases: [] });
  }

  for (const wiki of raw.wikis) {
    const subject = firstString(wiki, ['subject', 'title']);
    if (!subject) continue;
    for (const noun of titleNouns(subject)) {
      mergeConcept(concepts, { canonical: noun, kind: inferKind(noun, subject), aliases: [] });
    }
  }

  for (const document of raw.posts) {
    const subject = firstString(document.post, ['subject', 'title']);
    const prefix = subject ? titlePrefix(subject) : undefined;
    if (!prefix) continue;
    const alias = prefix.includes('.') ? prefix.split('.').at(-1) : undefined;
    mergeConcept(concepts, {
      canonical: prefix,
      kind: inferKind(prefix, 'component'),
      aliases: alias && alias !== prefix ? [alias] : [],
    });
  }

  const result = ConceptDictionarySchema.parse(
    [...concepts.values()].sort((left, right) => left.canonical.localeCompare(right.canonical)),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { outputPath, concepts: result };
}
