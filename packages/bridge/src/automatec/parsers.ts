/**
 * Strict parsers for AutomateC's standard output, forced to `/locale en-US`. Each accepts
 * exactly the lines AutomateC 7.5.1 prints on success (see test/fixtures/automatec) and
 * throws {@link UnexpectedOutputError} on anything else. Failures (non-zero exit code) are
 * handled by the client before parsing.
 */
import { UnexpectedOutputError } from "../errors.js";

const GUID = "[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}";
const GUID_ONLY = new RegExp(`^${GUID}$`);

/** Values of Blue Prism's SessionStatus as `/status` prints them (Terminated prints `Failed`). */
export const SESSION_STATUSES = [
  "Pending",
  "Running",
  "Failed",
  "Stopped",
  "Completed",
  "Debugging",
  "Archived",
  "StopRequested",
  "Stalled",
  "PendingDeletion",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** One row of a session log (`/getlog`). */
export interface LogEntry {
  /** As printed: `yyyy-MM-dd HH:mm:ss`, local time, no offset. */
  readonly time: string;
  readonly stageId: string;
  /** Empty for the first row ("Created session log", stage id all zeros). */
  readonly stageName: string;
  /** May be empty, contain commas, or span several lines (joined with `\n`). */
  readonly result: string;
}

/** What `/run` prints once the session is started. */
export interface RunOutput {
  readonly processName: string;
  readonly resource: string;
  readonly actualResource: string;
  readonly sessionId: string;
}

export function isGuid(value: string): boolean {
  return GUID_ONLY.test(value);
}

/** Lines of the output, without the final line break. Accepts CRLF and LF. */
function lines(output: string): string[] {
  const body = output.replace(/\r?\n$/, "");
  return body === "" ? [] : body.split(/\r?\n/);
}

function fail(command: string, output: string, reason: string): never {
  throw new UnexpectedOutputError("AutomateC", command, output, reason);
}

/** `/listprocesses`: one name per line (processes and business objects). */
export function parseListProcesses(output: string): string[] {
  const names = lines(output);
  if (names.some((n) => n.trim() === "")) fail("/listprocesses", output, "blank line");
  return names;
}

/** `/import`: `Importing <file>` then `Imported process` (also printed for objects). */
export function parseImport(output: string): void {
  const [first, second, ...rest] = lines(output);
  if (first?.startsWith("Importing ") !== true || second !== "Imported process" || rest.length) {
    fail("/import", output, "expected 'Importing …' then 'Imported process'");
  }
}

const ALREADY_PUBLISHED =
  "Error: This process has already been published to run in Blue Prism Enterprise.";

/**
 * `/publish` output, success or failure: `published`, `already-published` (AutomateC reports
 * it as an error; for us the goal is reached), or `undefined` for anything else.
 */
export function parsePublish(
  output: string,
  name: string,
): "published" | "already-published" | undefined {
  const all = lines(output);
  if (all.length !== 1) return undefined;
  if (all[0] === `Added 'Published' attribute to process '${name}'`) return "published";
  if (all[0] === ALREADY_PUBLISHED) return "already-published";
  return undefined;
}

/** `/export`: `Exported process` (also printed for objects). */
export function parseExport(output: string): void {
  const all = lines(output);
  if (all.length !== 1 || all[0] !== "Exported process") {
    fail("/export", output, "expected 'Exported process'");
  }
}

const SESSION_LINE = new RegExp(`^Session: (${GUID})$`);

/**
 * The session id of a `/run`, from its `Session: <id>` line, wherever it is and whatever the
 * rest says: once a session exists, the run must never be reported as failed.
 */
export function findRunSessionId(output: string): string | undefined {
  for (const line of lines(output)) {
    const match = SESSION_LINE.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Full `/run` success output, strictly (four lines, in order). */
export function parseRun(output: string): RunOutput {
  const all = lines(output);
  const [started, resource, actual, session] = all;
  const processName = started?.match(/^Started process:(.+)$/)?.[1];
  const res = resource?.match(/^Resource: (.+)$/)?.[1];
  const actualResource = actual?.match(/^Actual resource: (.+)$/)?.[1];
  const sessionId = session?.match(SESSION_LINE)?.[1];
  if (
    all.length !== 4 ||
    processName === undefined ||
    res === undefined ||
    actualResource === undefined ||
    sessionId === undefined
  ) {
    fail("/run", output, "expected Started process, Resource, Actual resource, Session");
  }
  return { processName, resource: res, actualResource, sessionId };
}

/**
 * `/run` failures that AutomateC reports before any session is created (en-US resources of
 * AutomateC 7.5.1). Any other failure without a session id leaves the outcome unknown.
 */
const RUN_FAILURES_BEFORE_SESSION = [
  /^Error: You must supply valid login details/,
  /^Error: process '.*' does not exist$/,
  /^Error: can not run process '.*' because it has not been published\.$/,
  /^Error: .* has been published as a Desktop process/,
  /^Error: can not create session to run process - /,
  /^Error: failed to retrieve process attributes from database - /,
  /^Error: Resource does not exist$/,
  /^(Error: )?Failed to get attributes of resource /,
  /^(Error: )?The pool .* is offline$/,
  /^Error: could not connect to resource /,
  /^(Error: )?Authentication error - /,
  /^Error: failed to create session - /,
];

export function isRunFailureBeforeSession(output: string): boolean {
  const all = lines(output);
  return (
    all.length > 0 && all.every((line) => RUN_FAILURES_BEFORE_SESSION.some((re) => re.test(line)))
  );
}

/** `/status <id>`: `Session: <id>` then `Status:<status>`. */
export function parseStatus(output: string, sessionId: string): SessionStatus {
  const all = lines(output);
  const id = all[0]?.match(SESSION_LINE)?.[1];
  const status = all[1]?.match(/^Status:(\w+)$/)?.[1];
  if (all.length !== 2 || id?.toLowerCase() !== sessionId.toLowerCase() || status === undefined) {
    fail("/status", output, `expected 'Session: ${sessionId}' then 'Status:<status>'`);
  }
  if (!(SESSION_STATUSES as readonly string[]).includes(status)) {
    fail("/status", output, `unknown status "${status}"`);
  }
  return status as SessionStatus;
}

const LOG_ENTRY = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}),(${GUID}),([^,]*),(.*)$`,
);

/**
 * `/getlog <id>`: `Log for session <id>:` then one `time,stageId,stageName,result` row per
 * log entry. The stage name ends at the first comma after the stage id: a stage name that
 * itself contains a comma is split wrongly (the stage id stays reliable). A line that is not
 * a row continues the previous row's result (a result with line breaks).
 */
export function parseLog(output: string, sessionId: string): LogEntry[] {
  const [header, ...rows] = lines(output);
  const id = header?.match(new RegExp(`^Log for session (${GUID}):$`))?.[1];
  if (id?.toLowerCase() !== sessionId.toLowerCase()) {
    fail("/getlog", output, `expected 'Log for session ${sessionId}:'`);
  }
  const entries: { time: string; stageId: string; stageName: string; result: string }[] = [];
  for (const row of rows) {
    const match = LOG_ENTRY.exec(row);
    if (match) {
      const [, time = "", stageId = "", stageName = "", result = ""] = match;
      entries.push({ time, stageId, stageName, result });
      continue;
    }
    const previous = entries.at(-1);
    if (!previous) fail("/getlog", output, "first row is not 'time,stageId,stageName,result'");
    previous.result += `\n${row}`;
  }
  return entries;
}

/** `/requeststop <id>`: `Stop requested for session: <id>`. */
export function parseRequestStop(output: string, sessionId: string): void {
  const all = lines(output);
  const id = all[0]?.match(/^Stop requested for session: (.+)$/)?.[1];
  if (all.length !== 1 || id?.toLowerCase() !== sessionId.toLowerCase()) {
    fail("/requeststop", output, `expected 'Stop requested for session: ${sessionId}'`);
  }
}

/** AutomateC's answer when the login is missing or refused. */
export function isLoginFailure(output: string): boolean {
  return /^Error: You must supply valid login details/m.test(output);
}
