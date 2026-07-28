import { execFile } from "node:child_process";

export interface DoorayExecutor {
  execute(args: readonly string[]): Promise<string>;
}

export class ChildProcessDoorayExecutor implements DoorayExecutor {
  execute(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "dooray",
        [...args],
        {
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim() || error.message;
            reject(new Error(detail, { cause: error }));
            return;
          }

          resolve(stdout);
        },
      );
    });
  }
}
