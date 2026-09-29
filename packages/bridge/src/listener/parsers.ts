/**
 * Strict parsers for the runtime resource listener's replies (Blue Prism 7.5.1, captured in
 * test/fixtures/listener). Each takes the reply lines, notifications (`>>…`) already removed.
 */
import { childElements, getAttr, parseBpXml, type BpElement } from "@bpdev/model";
import { CommandFailedError, UnexpectedOutputError } from "../errors.js";
import { redactElement, redactText } from "./redaction.js";

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
  /** Sanitized XML view; password/collection payloads are opaque, never the raw tree. */
  readonly element: BpElement;
  /** Password and unqualified collection payloads are deliberately withheld. */
  readonly redacted?: true;
}

/** Error replies seen from the 7.5.1 listener. */
const KNOWN_ERRORS = [
  /^INVALID COMMAND(?: - use 'help')?$/,
  /^USER NOT SET$/,
  /^SESSION NOT FOUND$/,
  /^INVALID ID$/,
];

/** A reply that is not the expected one: a known listener error, or unexpected output. */
function replyError(
  command: string,
  reply: readonly string[],
  reason: string,
): CommandFailedError | UnexpectedOutputError {
  const [first] = reply;
  if (reply.length === 1 && first !== undefined && KNOWN_ERRORS.some((re) => re.test(first))) {
    return new CommandFailedError("listener", command, "Listener refused the command");
  }
  // Error classes retain `output`: never pass untrusted replies, XML parser messages or
  // causes here, even if a caller did not register the secret that they contain.
  return new UnexpectedOutputError("listener", command, "[reply withheld]", reason);
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
  const number = Number(version);
  if (!Number.isSafeInteger(number)) throw replyError("version", reply, "invalid version number");
  return { product, version: number };
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

/** Incremental framing check: terminal line, error, or unsupported continuation. */
export function isStatusReplyComplete(reply: readonly string[]): boolean {
  if (reply.length === 0) return false;
  // Reject an unexpected continuation immediately; there is no documented delimiter for
  // multiline exception text. Do not guess that it belongs to the previous session.
  // Earlier lines have already been checked by the transport. Avoid rescanning the whole
  // reply for every session; the final parser still validates every line before returning.
  return (
    reply[0] !== STATUS_HEADER || (reply.length > 1 && !STATUS_SESSION.test(reply.at(-1) ?? ""))
  );
}

/**
 * `status` → `RESOURCE UNIT`, one ` - <STATUS> <sessionId>[ - <message>]` line per session,
 * then `Total running: N`.
 */
export function parseListenerStatus(
  reply: readonly string[],
  secrets: readonly string[] = [],
): ListenerStatus {
  const total = STATUS_TOTAL.exec(reply.at(-1) ?? "");
  if (reply[0] !== STATUS_HEADER || !total || reply.length < 2) {
    throw replyError("status", reply, `expected '${STATUS_HEADER}' … 'Total running: N'`);
  }
  const sessions = reply.slice(1, -1).map((line): ListenerSession => {
    const match = STATUS_SESSION.exec(line);
    if (!match) throw replyError("status", reply, "unexpected session line");
    const [, status, sessionId = "", message] = match;
    return {
      status: status as RunnerStatus,
      sessionId,
      ...(message === undefined ? {} : { message: redactText(message, secrets) }),
    };
  });
  const totalRunning = Number(total[1]);
  if (!Number.isSafeInteger(totalRunning)) {
    throw replyError("status", reply, "invalid session count");
  }
  return { sessions, totalRunning };
}

/** `outputs <id>` → `OUTPUTS:<outputs><output name type value />…</outputs>`. */
export function parseOutputs(
  reply: readonly string[],
  secrets: readonly string[] = [],
): SessionOutput[] {
  const [, xml = ""] = single("outputs", reply, /^OUTPUTS:(.*)$/);
  let root: BpElement;
  try {
    root = parseBpXml(xml).root;
  } catch {
    throw replyError("outputs", reply, "malformed XML");
  }
  if (root.name !== "outputs" || childElements(root).length !== root.children.length) {
    throw replyError("outputs", reply, "expected <outputs> holding <output> elements");
  }
  const elements = childElements(root);
  const outputSecrets = elements.flatMap((element) =>
    getAttr(element, "type") === "password" ? [getAttr(element, "value") ?? ""] : [],
  );
  const allSecrets = [...secrets, ...outputSecrets];
  return elements.map((element): SessionOutput => {
    const name = getAttr(element, "name");
    const type = getAttr(element, "type");
    if (element.name !== "output" || name === undefined || type === undefined) {
      throw replyError("outputs", reply, "expected <output name type>");
    }
    if (!(OUTPUT_TYPES as readonly string[]).includes(type)) {
      throw replyError("outputs", reply, "unknown output type");
    }
    let sanitized: BpElement;
    try {
      sanitized = redactElement(element, allSecrets);
    } catch {
      throw replyError("outputs", reply, "unsupported XML structure");
    }
    return {
      name: redactText(name, allSecrets),
      type: type as OutputType,
      value: getAttr(sanitized, "value"),
      element: sanitized,
      ...(type === "password" || type === "collection" ? { redacted: true as const } : {}),
    };
  });
}
