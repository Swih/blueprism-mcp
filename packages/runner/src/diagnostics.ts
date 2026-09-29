import type { LogEntry } from "@bpdev/bridge";
import type { LogEvidence, LoggedException } from "./contracts.js";
import { fingerprint } from "./store.js";

/** Only the exact ERROR: <type> : <detail> grammar captured in native getlog-failed.txt. */
export function exceptionEvidence(
  logs: readonly LogEntry[],
  session: string,
  observedAt: string,
): LogEvidence {
  const exceptions: LoggedException[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const [logIndex, row] of logs.entries()) {
    const match = /^ERROR: ([^:\r\n]+) : ([\s\S]*)$/.exec(row.result);
    const exceptionType = match?.[1];
    const detail = match?.[2];
    if (!exceptionType || detail === undefined) continue;
    const key = fingerprint(JSON.stringify([exceptionType, detail]));
    // Group identical text, without inferring whether BP propagated it or raised it again.
    if (seen.has(key)) continue;
    seen.add(key);
    if (exceptions.length === 20) {
      truncated = true;
      continue;
    }
    if (detail.length > 8192 || exceptionType.length > 256 || row.stageName.length > 1024)
      truncated = true;
    exceptions.push({
      logIndex,
      time: row.time.slice(0, 64),
      stageId: row.stageId.slice(0, 64),
      stageName: row.stageName.slice(0, 1024),
      exceptionType: exceptionType.slice(0, 256),
      detail: detail.slice(0, 8192),
    });
  }
  const [firstLoggedException, ...subsequentLoggedExceptions] = exceptions;
  return {
    source: "AutomateC/getLog",
    scope: "logged-exceptions-only",
    bpSessionId: session,
    observedAt,
    logCount: logs.length,
    logSha256: fingerprint(JSON.stringify(logs)),
    truncated,
    firstLoggedException,
    subsequentLoggedExceptions,
  };
}
