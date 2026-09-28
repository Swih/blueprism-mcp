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
} from "../errors.js";
import { runTool, type ToolRun } from "../process.js";
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
}

export interface RunOptions {
  /** `/resource`: the runtime resource to run on (e.g. `BPDEV-ROBOT`). */
  readonly resource: string;
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

  constructor(private readonly options: AutomateCOptions) {
    this.path = options.path ?? DEFAULT_AUTOMATEC_PATH;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.encoding = options.outputEncoding ?? "windows-1252";
  }

  /** Names of the processes and business objects the user can see. */
  async listProcesses(): Promise<string[]> {
    const run = await this.exec("/listprocesses", ["/listprocesses"]);
    return parseListProcesses(this.succeeded("/listprocesses", run));
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
    parseImport(this.succeeded("/import", await this.exec("/import", args)));
  }

  /**
   * Publishes a process (`/publish`) so it can be run. A process that is already published
   * is a success (`already-published`), not an error.
   */
  async publish(name: string): Promise<"published" | "already-published"> {
    checkName(name);
    const run = await this.exec("/publish", ["/publish", name]);
    const result = parsePublish(run.stdout, name);
    if (result !== undefined) return result;
    this.succeeded("/publish", run);
    throw new UnexpectedOutputError("AutomateC", "/publish", run.stdout, "unknown answer");
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
      parseExport(this.succeeded("/export", await this.exec("/export", ["/export", name], cwd)));
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
    if (options.resource.trim() === "") throw new InvalidArgumentError("Empty resource name");
    const inputs = options.inputs ?? [];
    const startp = inputs.length > 0 ? ["/startp", buildStartupInputs(inputs)] : [];
    const secrets = inputs.filter((i) => i.type === "password").map((i) => i.value);
    const run = await this.exec(
      "/run",
      [...startp, "/run", name, "/resource", options.resource],
      undefined,
      secrets,
    );
    const sessionId = findRunSessionId(run.stdout);
    if (sessionId !== undefined) return sessionId;
    if (isLoginFailure(run.stdout)) throw loginError(run);
    if (isRunFailureBeforeSession(run.stdout)) {
      throw new CommandFailedError("AutomateC", "/run", output(run), run.exitCode);
    }
    throw new RunOutcomeUnknownError(output(run), run.exitCode);
  }

  /** Status of a session (`/status`). */
  async status(sessionId: string): Promise<SessionStatus> {
    checkSessionId(sessionId);
    const run = await this.exec("/status", ["/status", sessionId]);
    return parseStatus(this.succeeded("/status", run), sessionId);
  }

  /** The session's stage log (`/getlog`). */
  async getLog(sessionId: string): Promise<LogEntry[]> {
    checkSessionId(sessionId);
    const run = await this.exec("/getlog", ["/getlog", sessionId]);
    return parseLog(this.succeeded("/getlog", run), sessionId);
  }

  /** Asks a running session to stop at its next stop check (`/requeststop`). */
  async requestStop(sessionId: string): Promise<void> {
    checkSessionId(sessionId);
    const run = await this.exec("/requeststop", ["/requeststop", sessionId]);
    parseRequestStop(this.succeeded("/requeststop", run), sessionId);
  }

  private async exec(
    command: string,
    args: readonly string[],
    cwd?: string,
    extraSecrets: readonly string[] = [],
  ): Promise<ToolRun> {
    const { user, password } = await this.options.credentials.getCredentials();
    const db = this.options.dbConnection;
    return runTool(
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
        secrets: [password, ...extraSecrets],
      },
    );
  }

  /** The standard output of a successful command; throws on a non-zero exit code. */
  private succeeded(command: string, run: ToolRun): string {
    if (run.exitCode === 0) return run.stdout;
    if (isLoginFailure(run.stdout)) throw loginError(run);
    throw new CommandFailedError("AutomateC", command, output(run), run.exitCode);
  }
}

function output(run: ToolRun): string {
  return run.stderr === "" ? run.stdout : `${run.stdout}${run.stderr}`;
}

function loginError(run: ToolRun): CredentialsError {
  return new CredentialsError(`AutomateC refused the login: ${run.stdout.trim()}`);
}

function checkName(name: string): void {
  if (name.trim() === "") throw new InvalidArgumentError("Empty process name");
}

function checkSessionId(sessionId: string): void {
  if (!isGuid(sessionId)) {
    throw new InvalidArgumentError(`Not a session id (GUID expected): ${sessionId}`);
  }
}
