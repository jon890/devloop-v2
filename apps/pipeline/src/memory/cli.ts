import path from "node:path";
import { DEFAULT_PROJECT, normalizeProjectCode } from "../cli-options";
import { normalizeEvidence } from "./evidence-normalizer";
import { extractExperience, type ExtractExperienceOptions } from "./experience-extractor";
import { searchMemory, type SearchOptions } from "./lexical-search";
import { buildMemoryWiki, type BuildMemoryWikiOptions } from "./wiki-builder";

export interface NormalizeCliOptions {
  project: string;
  gitRoot: string;
  dataDir: string;
}

export type ExtractCliOptions = ExtractExperienceOptions;
export type BuildCliOptions = BuildMemoryWikiOptions;
export type SearchCliOptions = Omit<SearchOptions, "project"> & { project: string; dataDir: string };

function requiredFlag(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 값을 입력해야 합니다.`);
  return value;
}

function optionalFlag(args: readonly string[], flag: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === flag ? [index] : []));
  if (indexes.length > 1) throw new Error(`${flag}는 한 번만 지정할 수 있습니다.`);
  if (indexes.length === 0) return undefined;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 값을 입력해야 합니다.`);
  return value;
}

function assertKnownFlags(args: readonly string[], command: string, flags: readonly string[]): void {
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !flags.includes(flag)) throw new Error(`${command}에서 지원하지 않는 option입니다: ${flag ?? ""}`);
    if (index + 1 >= args.length) throw new Error(`${flag} 값을 입력해야 합니다.`);
  }
}

function assertKnownValuedAndBooleanFlags(
  args: readonly string[],
  command: string,
  valuedFlags: readonly string[],
  booleanFlags: readonly string[],
): void {
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (!flag?.startsWith("--")) throw new Error(`${command}에서 지원하지 않는 option입니다: ${flag ?? ""}`);
    if (booleanFlags.includes(flag)) continue;
    if (!valuedFlags.includes(flag)) throw new Error(`${command}에서 지원하지 않는 option입니다: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${flag} 값을 입력해야 합니다.`);
    index += 1;
  }
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag}는 1 이상의 정수여야 합니다.`);
  return Number(value);
}

function booleanFlag(args: readonly string[], flag: string): boolean {
  const count = args.filter((value) => value === flag).length;
  if (count > 1) throw new Error(`${flag}는 한 번만 지정할 수 있습니다.`);
  return count === 1;
}

export function parseNormalizeArgs(args: readonly string[]): NormalizeCliOptions {
  if (args[0] !== "normalize") throw new Error("사용법: normalize --project <name> --git-root <path> [--data-dir <path>]");
  assertKnownFlags(args, "normalize", ["--project", "--git-root", "--data-dir"]);
  const dataDirValue = optionalFlag(args, "--data-dir");
  return {
    project: normalizeProjectCode(requiredFlag(args, "--project")),
    gitRoot: path.resolve(requiredFlag(args, "--git-root")),
    dataDir: dataDirValue ? path.resolve(dataDirValue) : path.resolve(__dirname, "../../data"),
  };
}

export function parseExtractArgs(args: readonly string[]): ExtractCliOptions {
  if (args[0] !== "extract") {
    throw new Error("사용법: extract [--project <name>] [--data-dir <path>] [--limit <n> | --ids <comma-list> | --sample-per-source <n>]");
  }
  assertKnownFlags(args, "extract", ["--project", "--data-dir", "--limit", "--ids", "--sample-per-source"]);
  const limit = positiveInteger(optionalFlag(args, "--limit"), "--limit");
  const samplePerSource = positiveInteger(optionalFlag(args, "--sample-per-source"), "--sample-per-source");
  const idsValue = optionalFlag(args, "--ids");
  const ids = idsValue?.split(",").map((id) => id.trim());
  if (ids?.some((id) => !id)) throw new Error("--ids에는 비어 있지 않은 packet ID를 쉼표로 구분해 입력해야 합니다.");
  if ([limit !== undefined, ids !== undefined, samplePerSource !== undefined].filter(Boolean).length > 1) {
    throw new Error("--limit, --ids, --sample-per-source는 상호 배타입니다.");
  }
  return {
    project: normalizeProjectCode(optionalFlag(args, "--project") ?? DEFAULT_PROJECT),
    dataDir: path.resolve(optionalFlag(args, "--data-dir") ?? path.resolve(__dirname, "../../data")),
    ...(limit === undefined ? {} : { limit }),
    ...(ids === undefined ? {} : { ids }),
    ...(samplePerSource === undefined ? {} : { samplePerSource }),
  };
}

export function parseBuildArgs(args: readonly string[]): BuildCliOptions {
  if (args[0] !== "build") throw new Error("사용법: build [--project <name>] [--data-dir <path>] [--allow-incomplete]");
  assertKnownValuedAndBooleanFlags(args, "build", ["--project", "--data-dir"], ["--allow-incomplete"]);
  return {
    project: normalizeProjectCode(optionalFlag(args, "--project") ?? DEFAULT_PROJECT),
    dataDir: path.resolve(optionalFlag(args, "--data-dir") ?? path.resolve(__dirname, "../../data")),
    allowIncomplete: booleanFlag(args, "--allow-incomplete"),
  };
}

export function parseSearchArgs(args: readonly string[]): SearchCliOptions {
  if (args[0] !== "search") {
    throw new Error(
      "사용법: search --query <text> [--project <name>] [--repository <name>] [--module <name>] [--path <path>] [--top-k <n>] [--data-dir <path>] [--allow-incomplete]",
    );
  }
  assertKnownValuedAndBooleanFlags(
    args,
    "search",
    ["--query", "--project", "--repository", "--module", "--path", "--top-k", "--data-dir"],
    ["--allow-incomplete"],
  );
  return {
    query: requiredFlag(args, "--query"),
    project: normalizeProjectCode(optionalFlag(args, "--project") ?? DEFAULT_PROJECT),
    dataDir: path.resolve(optionalFlag(args, "--data-dir") ?? path.resolve(__dirname, "../../data")),
    repository: optionalFlag(args, "--repository"),
    module: optionalFlag(args, "--module"),
    path: optionalFlag(args, "--path"),
    topK: positiveInteger(optionalFlag(args, "--top-k"), "--top-k"),
    allowIncomplete: booleanFlag(args, "--allow-incomplete"),
  };
}

export async function runMemoryCli(args: readonly string[]): Promise<void> {
  const normalizedArgs = args[1] === "--" ? [args[0], ...args.slice(2)] : args;
  const command = normalizedArgs[0];
  if (command === "search") {
    const options = parseSearchArgs(normalizedArgs);
    const result = await searchMemory(options.dataDir, options.project, options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const result =
    command === "normalize"
      ? await normalizeEvidence(parseNormalizeArgs(normalizedArgs))
      : command === "extract"
        ? await extractExperience(parseExtractArgs(normalizedArgs))
        : command === "build"
          ? await buildMemoryWiki(parseBuildArgs(normalizedArgs))
          : undefined;
  if (!result) throw new Error(`알 수 없는 Memory 명령입니다: ${command ?? ""}`);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  void runMemoryCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
