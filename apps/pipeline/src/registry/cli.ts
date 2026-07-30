import { isAbsolute, resolve } from "node:path";

export function requireFlag(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} 값을 입력해야 합니다.`);
  }
  return value.trim();
}

export function optionalFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    return undefined;
  }
  return value.trim() || undefined;
}

export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export function requireAbsolutePath(value: string, flag: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${flag} 은 절대 경로여야 합니다: ${value}`);
  }
  return resolve(value);
}
