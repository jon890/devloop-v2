import { Inject, Injectable } from '@nestjs/common';
import {
  RawDoorayObject,
  RawDoorayObjectSchema,
  RawNameMap,
  RawNameMapSchema,
  RawPostDocument,
  RawPostDocumentSchema,
  RawPosts,
  RawPostsSchema,
  RawWikiPageSchema,
} from '@devloop/shared';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DoorayExecutor } from './dooray-executor';
import { DEFAULT_RETRY_DELAYS_MS, DOORAY_EXECUTOR } from './ingest.const';

export interface IngestOptions {
  project: string;
  limit?: number;
  dataRoot?: string;
  retryDelaysMs?: readonly number[];
}

export interface IngestFailure {
  item: string;
  command: string;
  error: string;
}

export interface IngestStats {
  posts: number;
  wiki: number;
  tags: number;
  members: number;
}

export interface IngestResult {
  stats: IngestStats;
  failures: IngestFailure[];
}

interface IngestContext {
  projectRoot: string;
  postsDirectory: string;
  wikiDirectory: string;
  retryDelays: readonly number[];
  failures: IngestFailure[];
  memberSources: unknown[];
}

interface CollectedNameMaps {
  membersPath: string;
  members: RawNameMap;
}

@Injectable()
export class IngestService {
  constructor(@Inject(DOORAY_EXECUTOR) private readonly executor: DoorayExecutor) {}

  async ingest(options: IngestOptions): Promise<IngestResult> {
    validateOptions(options);

    const context = await this.prepareContext(options);
    const { membersPath, members } = await this.collectProjectData(options, context);
    await this.collectMissingMembers(members, membersPath, context);

    return this.buildResult(context, membersPath);
  }

  private async collectProjectData(
    options: IngestOptions,
    context: IngestContext,
  ): Promise<CollectedNameMaps> {
    const posts = await this.collectPostList(
      options.project,
      join(context.projectRoot, 'posts.json'),
      context.retryDelays,
      context.failures,
    );
    context.memberSources.push(posts);

    await this.collectPostDocuments(options, posts, context);

    const wikiPages = await this.collectWiki(
      options.project,
      context.wikiDirectory,
      options.limit,
      context.retryDelays,
      context.failures,
    );
    context.memberSources.push(wikiPages);

    await this.collectNameMap({
      path: join(context.projectRoot, 'tags.json'),
      args: ['project', 'tags', options.project, '--json'],
      item: 'tags',
      retryDelays: context.retryDelays,
      failures: context.failures,
    });

    const membersPath = join(context.projectRoot, 'members.json');
    const members = await this.collectNameMap({
      path: membersPath,
      args: ['member', 'list', options.project, '--json'],
      item: 'members',
      retryDelays: context.retryDelays,
      failures: context.failures,
    });

    return { membersPath, members };
  }

  private async prepareContext(options: IngestOptions): Promise<IngestContext> {
    const projectRoot = join(
      options.dataRoot ?? resolve(__dirname, '../../data/raw'),
      options.project,
    );
    const postsDirectory = join(projectRoot, 'posts');
    const wikiDirectory = join(projectRoot, 'wiki');
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const failures: IngestFailure[] = [];
    const memberSources: unknown[] = [];

    await mkdir(postsDirectory, { recursive: true });
    await mkdir(wikiDirectory, { recursive: true });

    return {
      projectRoot,
      postsDirectory,
      wikiDirectory,
      retryDelays,
      failures,
      memberSources,
    };
  }

  private async collectPostDocuments(
    options: IngestOptions,
    posts: RawPosts,
    context: IngestContext,
  ): Promise<void> {
    const selectedPosts = options.limit === undefined ? posts : posts.slice(0, options.limit);
    for (const summary of selectedPosts) {
      await this.collectPostDocument(options.project, summary, context);
    }
  }

  private async collectPostDocument(
    project: string,
    summary: RawDoorayObject,
    context: IngestContext,
  ): Promise<void> {
    const number = getPostNumber(summary);
    if (number === undefined) {
      context.failures.push({
        item: 'post:unknown',
        command: 'dooray post list',
        error: '업무 목록 항목에 number가 없습니다.',
      });
      return;
    }

    const destination = join(context.postsDirectory, `${number}.json`);
    const existing = await readExistingJson(destination, RawPostDocumentSchema);
    if (existing !== undefined) {
      context.memberSources.push(existing);
      return;
    }

    await this.fetchPostDocument(project, number, destination, context);
  }

  private async fetchPostDocument(
    project: string,
    number: string | number,
    destination: string,
    context: IngestContext,
  ): Promise<void> {
    const postArgs = ['post', 'get', project, String(number), '--json'];
    const commentArgs = ['post', 'comment', 'list', project, String(number), '--json'];
    try {
      const post = await this.executeJson(postArgs, RawDoorayObjectSchema.parse, context.retryDelays);
      const comments = await this.executeJson(
        commentArgs,
        (value) => RawPostsSchema.parse(value),
        context.retryDelays,
      );
      const document: RawPostDocument = { post, comments };
      await writeJson(destination, document);
      context.memberSources.push(document);
    } catch (error) {
      const failedArgs = error instanceof CommandFailure ? error.args : postArgs;
      context.failures.push(toFailure(`post:${number}`, failedArgs, error));
    }
  }

  private async collectMissingMembers(
    members: RawNameMap,
    membersPath: string,
    context: IngestContext,
  ): Promise<void> {
    const missingMemberIds = [...collectMemberIds(context.memberSources)]
      .filter((memberId) => members[memberId] === undefined)
      .sort();
    let membersChanged = false;

    for (const memberId of missingMemberIds) {
      const args = ['member', 'get', memberId, '--json'];
      try {
        const member = await this.executeJson(args, RawDoorayObjectSchema.parse, context.retryDelays);
        const name = getString(member, 'name');
        if (!name) {
          throw new Error('멤버 응답에 name이 없습니다.');
        }
        members[memberId] = name;
        membersChanged = true;
      } catch (error) {
        context.failures.push(toFailure(`member:${memberId}`, args, error));
      }
    }

    if (membersChanged) {
      await writeJson(membersPath, members);
    }
  }

  private async buildResult(context: IngestContext, membersPath: string): Promise<IngestResult> {
    return {
      stats: {
        posts: await countJsonFiles(context.postsDirectory),
        wiki: await countJsonFiles(context.wikiDirectory),
        tags: await fileCount(join(context.projectRoot, 'tags.json')),
        members: await fileCount(membersPath),
      },
      failures: context.failures,
    };
  }

  private async collectPostList(
    project: string,
    destination: string,
    retryDelays: readonly number[],
    failures: IngestFailure[],
  ): Promise<RawPosts> {
    const existing = await readExistingJson(destination, RawPostsSchema);
    if (existing !== undefined) {
      return existing;
    }

    const args = ['post', 'list', project, '--all', '--json'];
    try {
      const posts = await this.executeJson(args, RawPostsSchema.parse, retryDelays);
      await writeJson(destination, posts);
      return posts;
    } catch (error) {
      failures.push(toFailure('posts', args, error));
      return [];
    }
  }

  private async collectWiki(
    project: string,
    wikiDirectory: string,
    limit: number | undefined,
    retryDelays: readonly number[],
    failures: IngestFailure[],
  ): Promise<RawDoorayObject[]> {
    const rootArgs = ['wiki', 'pages', project, '--json'];
    let roots: RawPosts;
    try {
      roots = await this.executeJson(rootArgs, RawPostsSchema.parse, retryDelays);
    } catch (error) {
      failures.push(toFailure('wiki:roots', rootArgs, error));
      return [];
    }

    const queue = [...roots];
    const seen = new Set<string>();
    const pages: RawDoorayObject[] = [];

    while (queue.length > 0 && (limit === undefined || pages.length < limit)) {
      const discovered = queue.shift();
      if (!discovered) {
        break;
      }

      const pageId = getId(discovered);
      if (!pageId || seen.has(pageId)) {
        if (!pageId) {
          failures.push({
            item: 'wiki:unknown',
            command: formatCommand(rootArgs),
            error: '위키 목록 항목에 id가 없습니다.',
          });
        }
        continue;
      }
      seen.add(pageId);

      const destination = join(wikiDirectory, `${pageId}.json`);
      const existing = await readExistingJson(destination, RawWikiPageSchema);
      if (existing !== undefined) {
        pages.push(existing);
      } else {
        const pageArgs = ['wiki', 'page', 'get', project, pageId, '--json'];
        try {
          const page = await this.executeJson(pageArgs, RawWikiPageSchema.parse, retryDelays);
          await writeJson(destination, page);
          pages.push(page);
        } catch (error) {
          failures.push(toFailure(`wiki:${pageId}`, pageArgs, error));
        }
      }

      if (limit !== undefined && pages.length >= limit) {
        continue;
      }

      const childArgs = ['wiki', 'pages', project, '--parent', pageId, '--json'];
      try {
        const children = await this.executeJson(childArgs, RawPostsSchema.parse, retryDelays);
        queue.push(...children);
      } catch (error) {
        failures.push(toFailure(`wiki-children:${pageId}`, childArgs, error));
      }
    }

    return pages;
  }

  private async collectNameMap(options: {
    path: string;
    args: string[];
    item: string;
    retryDelays: readonly number[];
    failures: IngestFailure[];
  }): Promise<RawNameMap> {
    const existing = await readExistingJson(options.path, RawNameMapSchema);
    if (existing !== undefined) {
      return existing;
    }

    try {
      const entries = await this.executeJson(options.args, RawPostsSchema.parse, options.retryDelays);
      const map = toNameMap(entries);
      await writeJson(options.path, map);
      return map;
    } catch (error) {
      options.failures.push(toFailure(options.item, options.args, error));
      return {};
    }
  }

  private async executeJson<T>(
    args: readonly string[],
    parse: (value: unknown) => T,
    retryDelays: readonly number[],
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        const stdout = await this.executor.execute(args);
        return parse(JSON.parse(stdout) as unknown);
      } catch (error) {
        lastError = error;
        if (attempt < retryDelays.length) {
          await delay(retryDelays[attempt]);
        }
      }
    }

    throw new CommandFailure(args, lastError);
  }
}

class CommandFailure extends Error {
  constructor(
    readonly args: readonly string[],
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause });
  }
}

function validateOptions(options: IngestOptions): void {
  if (!options.project.trim()) {
    throw new Error('--project 값은 비어 있을 수 없습니다.');
  }
  if (
    options.project === '.' ||
    options.project === '..' ||
    options.project.includes('/') ||
    options.project.includes('\\')
  ) {
    throw new Error('--project 값에 경로 구분자를 사용할 수 없습니다.');
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit 값은 1 이상의 정수여야 합니다.');
  }
}

function getPostNumber(post: RawDoorayObject): string | number | undefined {
  const number = post.number;
  if (typeof number === 'string' || typeof number === 'number') {
    return number;
  }

  const taskNumber = post.taskNumber;
  if (typeof taskNumber === 'string') {
    return taskNumber.split('/').at(-1);
  }

  return undefined;
}

function getId(value: RawDoorayObject): string | undefined {
  const id = value.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function getString(value: RawDoorayObject, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key].trim() ? value[key] : undefined;
}

function toNameMap(entries: RawPosts): RawNameMap {
  const result: RawNameMap = {};
  for (const entry of entries) {
    const id = getId(entry) ?? getString(entry, 'organizationMemberId');
    const name = getString(entry, 'name');
    if (id && name) {
      result[id] = name;
    }
  }
  return result;
}

function collectMemberIds(values: unknown[]): Set<string> {
  const result = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (
        (key === 'organizationMemberId' || key === 'memberId') &&
        (typeof nested === 'string' || typeof nested === 'number')
      ) {
        result.add(String(nested));
      }
      visit(nested);
    }
  };

  values.forEach(visit);
  return result;
}

async function readExistingJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    return schema.parse(JSON.parse(content) as unknown);
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function countJsonFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
}

async function fileCount(path: string): Promise<number> {
  try {
    await readFile(path);
    return 1;
  } catch (error) {
    if (isFileNotFound(error)) {
      return 0;
    }
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function toFailure(item: string, args: readonly string[], error: unknown): IngestFailure {
  const failedArgs = error instanceof CommandFailure ? error.args : args;
  return {
    item,
    command: formatCommand(failedArgs),
    error: errorMessage(error),
  };
}

function formatCommand(args: readonly string[]): string {
  return ['dooray', ...args].join(' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
