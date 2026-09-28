import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { ToolLaunchError, ToolTimeoutError, type BridgeTool } from "./errors.js";

/** What a finished tool printed, decoded and with every secret masked. */
export interface ToolRun {
  /** `null` when the process was ended by a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ToolRunOptions {
  readonly tool: BridgeTool;
  /** Short command label for error messages (e.g. `/status`); never the full argument list. */
  readonly command: string;
  readonly timeoutMs: number;
  /** Encoding of the tool's output (a WHATWG label, e.g. `windows-1252`). */
  readonly encoding: string;
  readonly cwd?: string;
  /** Values replaced by `***` in the captured output. */
  readonly secrets?: readonly string[];
}

export const MASK = "***";

/**
 * Runs an executable with an argument array, never through a shell, and returns its decoded
 * and masked output. A non-zero exit code is not an error here: callers interpret it.
 *
 * The child is started without a console (`detached`, i.e. DETACHED_PROCESS on Windows).
 * .NET Framework tools then write in the ANSI code page (windows-1252 on Western systems),
 * which `TextDecoder` reads, instead of the console's OEM code page (850), which it cannot.
 * Errors never carry the arguments: they may hold a password.
 */
export function runTool(
  executable: string,
  args: readonly string[],
  options: ToolRunOptions,
): Promise<ToolRun> {
  const { tool, command, timeoutMs, cwd, secrets = [] } = options;
  const decoder = new TextDecoder(options.encoding); // RangeError on an unknown label, up front
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, args, {
        cwd,
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Node's message may quote an argument (e.g. one with a NUL byte): do not keep it.
      reject(new ToolLaunchError(tool, `Cannot start ${executable}: invalid arguments`));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      if (!settle()) return;
      child.kill();
      reject(new ToolTimeoutError(tool, command, timeoutMs));
    }, timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Only the error code is kept: the error object lists the arguments (`spawnargs`).
      if (settle()) {
        reject(new ToolLaunchError(tool, `Cannot start ${executable}: ${error.code ?? "error"}`));
      }
    });
    child.on("close", (exitCode: number | null) => {
      if (!settle()) return;
      const decode = (chunks: Buffer[]): string =>
        maskSecrets(decoder.decode(Buffer.concat(chunks)), secrets);
      resolve({ exitCode, stdout: decode(out), stderr: decode(err) });
    });
  });
}

/** Replaces every occurrence of each non-empty secret with {@link MASK}, longest first. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((s) => s !== "")
    .toSorted((a, b) => b.length - a.length)
    .reduce((masked, secret) => masked.replaceAll(secret, MASK), text);
}
