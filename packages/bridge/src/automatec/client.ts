import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CredentialProvider } from "../credentials.js";
import {
  CommandFailedError,
  CredentialsError,
  InvalidArgumentError,
  RunOutcomeUnknownError,
  UnexpectedOutputError,
  ToolTimeoutError,
  ToolOutputLimitError,
} from "../errors.js";
import { maskSecrets, runTool, type ToolRun } from "../process.js";
import { buildStartupInputs, type StartupParam } from "./inputs.js";
import {
  findRunSessionId,
  isGuid,
  isLoginFailure,
  isRunFailureBeforeSession,
  parseExport,
  parseImport,
  parseListProcesses,
  parseLog,
  parsePublish,
  parseRequestStop,
  parseStatus,
  type LogEntry,
  type SessionStatus,
} from "./parsers.js";

export const DEFAULT_AUTOMATEC_PATH =
  "C:\\Program Files\\Blue Prism Limited\\Blue Prism Automate\\AutomateC.exe";

export interface AutomateCOptions {
  readonly credentials: CredentialProvider;
  /** Defaults to {@link DEFAULT_AUTOMATEC_PATH}. */
  readonly path?: string;
  /** `/dbconname`: the Blue Prism connection to use (default: AutomateC's current one). */
  readonly dbConnection?: string;
  /** Per command. Default 120 000 ms. */
  readonly timeoutMs?: number;
  /** Encoding of AutomateC's output: the Windows ANSI code page. Default `windows-1252`. */
  readonly outputEncoding?: string;
  readonly maxOutputBytes?: number;
}

export interface RunOptions {
  /** `/resource`: the runtime resource to run on (e.g. `BPDEV-ROBOT`). */
  readonly resource: string;
  readonly port?: number;
  /** `/startp`: typed startup parameters. */
  readonly inputs?: readonly StartupParam[];
}

/**
 * Blue Prism's command-line client (AutomateC.exe). Every command runs with `/locale en-US`
 * and a native login from the credential provider, and its output is parsed strictly.
 *
 * Known limitation: AutomateC takes the password on its command line (`/user <name> <pwd>`),
 * so it is visible to local process listings while the command runs. It is masked in every
 * captured output and never appears in errors.
 */
export class AutomateC {
  private readonly path: string;
  private readonly timeoutMs: number;
  private readonly encoding: string;
  private readonly sessionSecrets = new Map<string, readonly string[]>();

  constructor(private readonly options: AutomateCOptions) {
    this.path = options.path ?? DEFAULT_AUTOMATEC_PATH;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.encoding = options.outputEncoding ?? "windows-1252";
  }

  /** Names of the processes and business objects the user can see. */
  async listProcesses(): Promise<string[]> {
    return this.exec("/listprocesses", ["/listprocesses"], (run, redact) =>
      parseListProcesses(this.succeeded("/listprocesses", run)).map(redact),
    );
  }

  /** Create a new isolated queue through the native documented CLI, without release overwrite. */
  async createQueue(name: string, keyField = "CaseKey", maxAttempts = 1): Promise<string> {
    checkName(name);
    if (
      !name.startsWith("BPDEV ") ||
      !/^[A-Za-z][A-Za-z0-9 ]{0,79}$/.test(keyField) ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 10
    )
      throw new InvalidArgumentError(
        "Queue creation requires a BPDEV name, simple key field and 1–10 attempts",
      );
    return this.exec(
      "/createqueue",
      ["/createqueue", keyField, "True", String(maxAttempts), "/queuename", name],
      (run) => {
        const output = this.succeeded("/createqueue", run);
        const match = /^Created queue: ([a-f0-9-]{36})\r?\n?$/i.exec(output);
        if (!match?.[1] || !isGuid(match[1]))
          throw new UnexpectedOutputError(
            "AutomateC",
            "/createqueue",
            output,
            "expected native queue acknowledgement; reconcile before retrying",
          );
        return match[1];
      },
    );
  }

  /** Imports a process or object file (`/import`), optionally with `/overwrite`. */
  async import(file: string, options: { readonly overwrite?: boolean } = {}): Promise<void> {
    // AutomateC expands wildcards in the file name: refuse them so one call = one file.
    if (/[*?]/.test(file)) throw new InvalidArgumentError("Wildcards are not allowed in the file");
    const path = resolve(file);
    await access(path).catch(() => {
      throw new InvalidArgumentError(`File not found: ${path}`);
    });
    const args = ["/import", path, ...(options.overwrite === true ? ["/overwrite"] : [])];
    await this.exec("/import", args, (run) => {
      parseImport(this.succeeded("/import", run));
    });
  }

  /**
   * Publishes a process (`/publish`) so it can be run. A process that is already published
   * is a success (`already-published`), not an error.
   */
  async publish(name: string): Promise<"published" | "already-published"> {
    checkName(name);
    return this.exec("/publish", ["/publish", name], (run) => {
      this.checkInterruption("/publish", run);
      const result = parsePublish(run.stdout, name);
      if (result !== undefined) return result;
      this.succeeded("/publish", run);
      throw new UnexpectedOutputError("AutomateC", "/publish", run.stdout, "unknown answer");
    });
  }

  /**
   * Exports a process or object (`/export`) and returns the path of the written file. The
   * file is written in a new, empty directory created under `options.dir` (default: the
   * system temporary directory), named as Blue Prism names it (`BPA Process - <name>.xml`).
   */
  async export(name: string, options: { readonly dir?: string } = {}): Promise<string> {
    checkName(name);
    const cwd = await mkdtemp(join(options.dir ?? tmpdir(), "bpdev-export-"));
    try {
      await this.exec(
        "/export",
        ["/export", name],
        (run) => {
          parseExport(this.succeeded("/export", run));
        },
        cwd,
      );
      const files = await readdir(cwd);
      const [file] = files;
      if (files.length !== 1 || file === undefined) {
        throw new UnexpectedOutputError(
          "AutomateC",
          "/export",
          `Exported process (files written: ${files.length})`,
          "expected exactly one exported file",
        );
      }
      return join(cwd, file);
    } catch (error) {
      await rm(cwd, { recursive: true, force: true }); // our own, fresh directory
      throw error;
    }
  }

  /**
   * Starts a process on a resource (`/run`) and returns the session id.
   *
   * As soon as AutomateC prints a session id the run is reported as started, whatever else
   * it printed. Without one, a failure known to happen before any session exists throws
   * {@link CommandFailedError}; anything else throws {@link RunOutcomeUnknownError}.
   */
  async run(name: string, options: RunOptions): Promise<string> {
    checkName(name);
    checkName(options.resource);
    if (
      options.port !== undefined &&
      (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    )
      throw new InvalidArgumentError("Invalid runtime port");
    const inputs = options.inputs ?? [];
    const startp = inputs.length > 0 ? ["/startp", buildStartupInputs(inputs)] : [];
    const secrets = inputs.filter((i) => i.type === "password").map((i) => i.value);
    const sessionId = await this.exec(
      "/run",
      [
        ...startp,
        "/run",
        name,
        "/resource",
        options.resource,
        ...(options.port === undefined ? [] : ["/port", String(options.port)]),
      ],
      (run) => {
        const sessionId = findRunSessionId(run.stdout);
        if (sessionId !== undefined) return sessionId;
        // Interrupted clients cannot prove that a robot was never created. No automatic retry.
        if (!run.interruption && isLoginFailure(run.stdout)) throw loginError(run);
        if (!run.interruption && isRunFailureBeforeSession(run.stdout)) {
          throw new CommandFailedError("AutomateC", "/run", output(run), run.exitCode);
        }
        throw new RunOutcomeUnknownError(output(run), run.exitCode);
      },
      undefined,
      secrets,
    );
    this.sessionSecrets.set(sessionId.toLowerCase(), secrets);
    return sessionId;
  }

  /** Status of a session (`/status`). */
  async status(sessionId: string): Promise<SessionStatus> {
    checkSessionId(sessionId);
    return this.exec("/status", ["/status", sessionId], (run) =>
      parseStatus(this.succeeded("/status", run), sessionId),
    );
  }

  /** The session's stage log (`/getlog`). */
  async getLog(sessionId: string): Promise<LogEntry[]> {
    checkSessionId(sessionId);
    return this.exec(
      "/getlog",
      ["/getlog", sessionId],
      (run, redact) =>
        parseLog(this.succeeded("/getlog", run), sessionId).map((entry) => ({
          ...entry,
          stageName: redact(entry.stageName),
          result: redact(entry.result),
        })),
      undefined,
      this.sessionSecrets.get(sessionId.toLowerCase()) ?? [],
    );
  }

  /** Asks a running session to stop at its next stop check (`/requeststop`). */
  async requestStop(sessionId: string): Promise<void> {
    checkSessionId(sessionId);
    await this.exec("/requeststop", ["/requeststop", sessionId], (run) => {
      parseRequestStop(this.succeeded("/requeststop", run), sessionId);
    });
  }

  private async exec<T>(
    command: string,
    args: readonly string[],
    interpret: (run: ToolRun, redact: (value: string) => string) => T,
    cwd?: string,
    extraSecrets: readonly string[] = [],
  ): Promise<T> {
    const { user, password } = await this.options.credentials.getCredentials();
    const db = this.options.dbConnection;
    const secrets = [password, ...extraSecrets];
    const redact = (value: string): string => maskSecrets(value, secrets);
    const run = await runTool(
      this.path,
      [
        "/user",
        user,
        password,
        ...(db === undefined ? [] : ["/dbconname", db]),
        ...args,
        "/locale",
        "en-US",
      ],
      {
        tool: "AutomateC",
        command,
        cwd,
        timeoutMs: this.timeoutMs,
        encoding: this.encoding,
        secrets,
        maxOutputBytes: this.options.maxOutputBytes,
      },
    );
    // Only typed, interpreted values leave this boundary. Never attach a raw cause.
    try {
      return interpret(run, redact);
    } catch (error) {
      if (error instanceof RunOutcomeUnknownError)
        throw new RunOutcomeUnknownError(redact(error.output), error.exitCode);
      if (error instanceof CommandFailedError)
        throw new CommandFailedError(
          error.tool,
          error.command,
          redact(error.output),
          error.exitCode,
        );
      if (error instanceof UnexpectedOutputError)
        throw new UnexpectedOutputError(
          error.tool,
          error.command,
          redact(error.output),
          "reply did not match the expected protocol",
        );
      if (error instanceof CredentialsError) throw new CredentialsError(redact(error.message));
      if (error instanceof ToolTimeoutError)
        throw new ToolTimeoutError(
          error.tool,
          error.command,
          error.timeoutMs,
          redact(error.output),
        );
      if (error instanceof ToolOutputLimitError)
        throw new ToolOutputLimitError(error.tool, error.command, redact(error.output));
      throw new UnexpectedOutputError("AutomateC", command, "", "cannot interpret response");
    }
  }

  /** The standard output of a successful command; throws on a non-zero exit code. */
  private succeeded(command: string, run: ToolRun): string {
    this.checkInterruption(command, run);
    if (run.exitCode === 0) return run.stdout;
    if (isLoginFailure(run.stdout)) throw loginError(run);
    throw new CommandFailedError("AutomateC", command, output(run), run.exitCode);
  }

  private checkInterruption(command: string, run: ToolRun): void {
    if (run.interruption === "timeout")
      throw new ToolTimeoutError("AutomateC", command, this.timeoutMs, output(run));
    if (run.interruption === "output-limit")
      throw new ToolOutputLimitError("AutomateC", command, output(run));
  }
}

function output(run: ToolRun): string {
  return run.stderr === "" ? run.stdout : `${run.stdout}${run.stderr}`;
}

function loginError(run: ToolRun): CredentialsError {
  return new CredentialsError(`AutomateC refused the login: ${run.stdout.trim()}`);
}

function checkName(name: string): void {
  if (name.trim() === "" || /^\s*[-/]/.test(name) || /\p{Cc}/u.test(name))
    throw new InvalidArgumentError(
      "Name must be nonempty, contain no control characters and not start with an option prefix",
    );
}

function checkSessionId(sessionId: string): void {
  if (!isGuid(sessionId)) {
    throw new InvalidArgumentError(`Not a session id (GUID expected): ${sessionId}`);
  }
}
