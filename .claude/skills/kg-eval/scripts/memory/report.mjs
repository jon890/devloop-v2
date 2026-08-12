import { readFile } from "node:fs/promises";
import { loadMemoryEvaluationInputs } from "../validate-memory-suite.mjs";

function extractReportHash(reportText, label) {
  const pattern = new RegExp("\\|\\s*" + label + "\\s*\\|\\s*`([0-9a-f]{64})`\\s*\\|", "i");
  return reportText.match(pattern)?.[1] ?? null;
}

async function validateMemoryReportDigests({ reportPath, suitePath, sourceLockPath }) {
  const [reportText, inputs] = await Promise.all([readFile(reportPath, "utf8"), loadMemoryEvaluationInputs({ suitePath, sourceLockPath })]);
  const reportSuiteHash = extractReportHash(reportText, "Suite hash");
  const reportSourceLockHash = extractReportHash(reportText, "Source lock hash");
  const failures = {
    missingSuiteHash: reportSuiteHash ? 0 : 1,
    missingSourceLockHash: reportSourceLockHash ? 0 : 1,
    suiteHashMismatch: reportSuiteHash && reportSuiteHash !== inputs.suiteHash ? 1 : 0,
    sourceLockHashMismatch: reportSourceLockHash && reportSourceLockHash !== inputs.sourceLockHash ? 1 : 0,
  };
  const totalFailures = Object.values(failures).reduce((sum, count) => sum + count, 0);
  const result = {
    suiteHash: inputs.suiteHash,
    sourceLockHash: inputs.sourceLockHash,
    reportSuiteHash,
    reportSourceLockHash,
    failures,
  };
  if (totalFailures > 0) {
    const error = new Error(`memory report digest validation failed: ${JSON.stringify(failures)}`);
    error.result = result;
    throw error;
  }
  return result;
}

export { extractReportHash, validateMemoryReportDigests };
