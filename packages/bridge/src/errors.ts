/** The external tool a bridge error comes from. */
export type BridgeTool = "AutomateC" | "listener" | "bpprobe";

/**
 * Base class of every error thrown by @bpdev/bridge. Messages and captured outputs never
 * contain the password: outputs are masked before any error is built.
 */
export class BpBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A caller argument is unusable (bad session id, empty name, forbidden character...). */
export class InvalidArgumentError extends BpBridgeError {}

/** Credentials are missing or were refused. */
export class CredentialsError extends BpBridgeError {}

/** The tool could not be started (executable not found, access denied...). */
export class ToolLaunchError extends BpBridgeError {
  constructor(
    readonly tool: BridgeTool,
    message: string,
  ) {
    super(message);
  }
}

/** The tool or the listener did not answer in time. */
export class ToolTimeoutError extends BpBridgeError {
  constructor(
    readonly tool: BridgeTool,
    readonly command: string,
    readonly timeoutMs: number,
    readonly output = "",
  ) {
    super(`${tool} ${command} did not finish within ${timeoutMs} ms`);
  }
}

/** The tool exceeded its output budget; diagnostics are explicitly incomplete. */
export class ToolOutputLimitError extends BpBridgeError {
  constructor(
    readonly tool: BridgeTool,
    readonly command: string,
    readonly output: string,
  ) {
    super(`${tool} ${command} exceeded its output limit; diagnostics are truncated`);
  }
}

/** The tool ran and reported a failure. `output` is what it printed (masked). */
export class CommandFailedError extends BpBridgeError {
  constructor(
    readonly tool: BridgeTool,
    readonly command: string,
    readonly output: string,
    readonly exitCode?: number | null,
  ) {
    super(`${tool} ${command} failed: ${summary(output)}`);
  }
}

/**
 * The tool's output does not match the expected grammar. Nothing is guessed from it: the
 * raw (masked) output is kept for diagnosis.
 */
export class UnexpectedOutputError extends BpBridgeError {
  constructor(
    readonly tool: BridgeTool,
    readonly command: string,
    readonly output: string,
    reason: string,
  ) {
    super(`Unexpected ${tool} ${command} output (${reason}): ${summary(output)}`);
  }
}

/**
 * `/run` printed no session id and no failure known to happen before a session exists.
 * A session may have been created or even started: check before running again.
 */
export class RunOutcomeUnknownError extends BpBridgeError {
  constructor(
    readonly output: string,
    readonly exitCode: number | null,
  ) {
    super(
      `AutomateC /run printed no session id; a session may exist, check the resource before ` +
        `retrying: ${summary(output)}`,
    );
  }
}

/** The runtime listener cannot be reached, or closed the connection. */
export class ListenerConnectionError extends BpBridgeError {}

function summary(output: string): string {
  const text = output.trim().replaceAll(/\s*\r?\n\s*/g, " | ");
  if (text === "") return "(no output)";
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
