import path from "node:path";
import { normalizeEvidence } from "./evidence-normalizer";

interface NormalizeCliOptions {
  project: string;
  gitRoot: string;
  dataDir: string;
}

function requiredFlag(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 값을 입력해야 합니다.`);
  return value;
}

export function parseNormalizeArgs(args: readonly string[]): NormalizeCliOptions {
  if (args[0] !== "normalize") throw new Error("사용법: normalize --project <name> --git-root <path> [--data-dir <path>]");
  const dataDirIndex = args.indexOf("--data-dir");
  const dataDirValue = dataDirIndex < 0 ? undefined : args[dataDirIndex + 1];
  if (dataDirIndex >= 0 && (!dataDirValue || dataDirValue.startsWith("-"))) throw new Error("--data-dir 값을 입력해야 합니다.");
  return {
    project: requiredFlag(args, "--project").trim(),
    gitRoot: path.resolve(requiredFlag(args, "--git-root")),
    dataDir: dataDirValue ? path.resolve(dataDirValue) : path.resolve(__dirname, "../../data"),
  };
}

export async function runMemoryCli(args: readonly string[]): Promise<void> {
  const options = parseNormalizeArgs(args);
  const result = await normalizeEvidence(options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  void runMemoryCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
