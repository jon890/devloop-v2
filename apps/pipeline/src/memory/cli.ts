import path from "node:path";
import { DEFAULT_PROJECT } from "../cli-options";
import { normalizeEvidence } from "./evidence-normalizer";
import { extractExperience, type ExtractExperienceOptions } from "./experience-extractor";

export interface NormalizeCliOptions {
  project: string;
  gitRoot: string;
  dataDir: string;
}

export type ExtractCliOptions = ExtractExperienceOptions;

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

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag}는 1 이상의 정수여야 합니다.`);
  return Number(value);
}

export function parseNormalizeArgs(args: readonly string[]): NormalizeCliOptions {
  if (args[0] !== "normalize") throw new Error("사용법: normalize --project <name> --git-root <path> [--data-dir <path>]");
  assertKnownFlags(args, "normalize", ["--project", "--git-root", "--data-dir"]);
  const dataDirValue = optionalFlag(args, "--data-dir");
  return {
    project: requiredFlag(args, "--project").trim(),
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
    project: optionalFlag(args, "--project")?.trim() || DEFAULT_PROJECT,
    dataDir: path.resolve(optionalFlag(args, "--data-dir") ?? path.resolve(__dirname, "../../data")),
    ...(limit === undefined ? {} : { limit }),
    ...(ids === undefined ? {} : { ids }),
    ...(samplePerSource === undefined ? {} : { samplePerSource }),
  };
}

export async function runMemoryCli(args: readonly string[]): Promise<void> {
  const command = args[0];
  const result =
    command === "normalize"
      ? await normalizeEvidence(parseNormalizeArgs(args))
      : command === "extract"
        ? await extractExperience(parseExtractArgs(args))
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
