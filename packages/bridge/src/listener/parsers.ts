/**
 * Strict parsers for the runtime resource listener's replies (Blue Prism 7.5.1, captured in
 * test/fixtures/listener). Each takes the reply lines, notifications (`>>…`) already removed.
 */
import { BpModelError, childElements, getAttr, parseBpXml, type BpElement } from "@bpdev/model";
import { CommandFailedError, UnexpectedOutputError } from "../errors.js";

const GUID = "[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}";

/** Session states as the listener prints them (Blue Prism's RunnerStatus). */
export const RUNNER_STATUSES = [
  "UNKNOWN",
  "PENDING",
  "RUNNING",
  "FAILED",
  "STOPPED",
  "STOPPING",
  "COMPLETED",
  "STARTFAILED",
  "IDLE",
] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

/** What the resource can accept (Blue Prism's BusinessObjectRunMode). */
export const AVAILABILITIES = ["None", "Exclusive", "Background", "Foreground"] as const;
export type ListenerAvailability = (typeof AVAILABILITIES)[number];

/** Blue Prism data types of session outputs. */
export const OUTPUT_TYPES = [
  "binary",
  "collection",
  "date",
  "datetime",
  "flag",
  "image",
  "number",
  "password",
  "text",
  "time",
  "timespan",
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

export interface ListenerVersion {
  /** `AUTOMATE RESOURCE PC / LISTENER`. */
  readonly product: string;
  /** Listener protocol version (4 on 7.5.1). */
  readonly version: number;
}

export interface ListenerSession {
  readonly status: RunnerStatus;
  readonly sessionId: string;
  /** Present on failures, e.g. `System Exception : <message>`. */
  readonly message?: string;
}

export interface ListenerStatus {
  /** Sessions the runtime still holds in memory (they are lost when it restarts). */
  readonly sessions: ListenerSession[];
  /** The `Total running: N` line, as reported. */
  readonly totalRunning: number;
}

export interface SessionOutput {
  readonly name: string;
  readonly type: OutputType;
  /** Blue Prism's text form of the value; `undefined` when the output has no `value`. */
  readonly value: string | undefined;
  /** The `<output>` element itself, for non-scalar values (collections). */
  readonly element: BpElement;
}

/** Error replies seen from the 7.5.1 listener. */
const KNOWN_ERRORS = [/^INVALID COMMAND/, /^USER NOT SET$/, /^SESSION NOT FOUND$/, /^INVALID ID$/];

/** A reply that is not the expected one: a known listener error, or unexpected output. */
export function replyError(
  command: string,
  reply: readonly string[],
  reason: string,
): CommandFailedError | UnexpectedOutputError {
  const text = reply.join("\n");
  const [first] = reply;
  if (reply.length === 1 && first !== undefined && KNOWN_ERRORS.some((re) => re.test(first))) {
    return new CommandFailedError("listener", command, text);
  }
  return new UnexpectedOutputError("listener", command, text, reason);
}

function single(command: string, reply: readonly string[], pattern: RegExp): RegExpExecArray {
  const match = reply.length === 1 ? pattern.exec(reply[0] ?? "") : null;
  if (!match) throw replyError(command, reply, `expected one line matching ${String(pattern)}`);
  return match;
}

/** `version` → `AUTOMATE RESOURCE PC / LISTENER 4`. */
export function parseVersion(reply: readonly string[]): ListenerVersion {
  const [, product = "", version = ""] = single(
    "version",
    reply,
    /^(AUTOMATE RESOURCE PC \/ LISTENER) (\d+)$/,
  );
  return { product, version: Number(version) };
}

/** `busy` → `yes` / `no`. */
export function parseBusy(reply: readonly string[]): boolean {
  return single("busy", reply, /^(yes|no)$/)[1] === "yes";
}

/** `availability` → `AVAILABILITY:<run mode>`. */
export function parseAvailability(reply: readonly string[]): ListenerAvailability {
  const pattern = new RegExp(`^AVAILABILITY:(${AVAILABILITIES.join("|")})$`);
  return single("availability", reply, pattern)[1] as ListenerAvailability;
}

const STATUS_HEADER = "RESOURCE UNIT";
const STATUS_SESSION = new RegExp(`^ - (${RUNNER_STATUSES.join("|")}) (${GUID})(?: - (.*))?$`);
const STATUS_TOTAL = /^Total running: (\d+)$/;

/** Whether a `status` reply is complete (its last line is `Total running: N`, or an error). */
export function isStatusReplyComplete(reply: readonly string[]): boolean {
  if (reply.length === 0) return false;
  return reply[0] !== STATUS_HEADER || STATUS_TOTAL.test(reply.at(-1) ?? "");
}

/**
 * `status` → `RESOURCE UNIT`, one ` - <STATUS> <sessionId>[ - <message>]` line per session,
 * then `Total running: N`.
 */
export function parseListenerStatus(reply: readonly string[]): ListenerStatus {
  const total = STATUS_TOTAL.exec(reply.at(-1) ?? "");
  if (reply[0] !== STATUS_HEADER || !total || reply.length < 2) {
    throw replyError("status", reply, `expected '${STATUS_HEADER}' … 'Total running: N'`);
  }
  const sessions = reply.slice(1, -1).map((line): ListenerSession => {
    const match = STATUS_SESSION.exec(line);
    if (!match) throw replyError("status", reply, `unexpected session line "${line}"`);
    const [, status, sessionId = "", message] = match;
    return {
      status: status as RunnerStatus,
      sessionId,
      ...(message === undefined ? {} : { message }),
    };
  });
  return { sessions, totalRunning: Number(total[1]) };
}

/** `outputs <id>` → `OUTPUTS:<outputs><output name type value />…</outputs>`. */
export function parseOutputs(reply: readonly string[]): SessionOutput[] {
  const [, xml = ""] = single("outputs", reply, /^OUTPUTS:(.*)$/);
  let root: BpElement;
  try {
    root = parseBpXml(xml).root;
  } catch (error) {
    if (!(error instanceof BpModelError)) throw error;
    throw replyError("outputs", reply, `malformed XML: ${error.message}`);
  }
  if (root.name !== "outputs" || childElements(root).length !== root.children.length) {
    throw replyError("outputs", reply, "expected <outputs> holding <output> elements");
  }
  return childElements(root).map((element): SessionOutput => {
    const name = getAttr(element, "name");
    const type = getAttr(element, "type");
    if (element.name !== "output" || name === undefined || type === undefined) {
      throw replyError("outputs", reply, "expected <output name type>");
    }
    if (!(OUTPUT_TYPES as readonly string[]).includes(type)) {
      throw replyError("outputs", reply, `unknown output type "${type}"`);
    }
    return { name, type: type as OutputType, value: getAttr(element, "value"), element };
  });
}
