import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { InvalidArgumentError, ToolLaunchError, type BridgeTool } from "./errors.js";

/** Internal, unredacted protocol data. Never expose this transport through the public API. */
export interface ToolRun {
  /** `null` when the process was ended by a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The client was interrupted; this says nothing about a robot it may have started. */
  readonly interruption?: "timeout" | "output-limit";
}

export interface ToolRunOptions {
  readonly tool: BridgeTool;
  /** Short command label for error messages (e.g. `/status`); never the full argument list. */
  readonly command: string;
  readonly timeoutMs: number;
  /** Encoding of the tool's output (a WHATWG label, e.g. `windows-1252`). */
  readonly encoding: string;
  readonly cwd?: string;
  /** Values masked in transport errors; successful protocol data remains internal and raw. */
  readonly secrets?: readonly string[];
  /** Combined stdout/stderr budget. Default 4 MiB; exceeding it interrupts the client. */
  readonly maxOutputBytes?: number;
}

export const MASK = "***";

/**
 * Runs an executable with an argument array, never through a shell, and returns its decoded
 * output for internal parsing. Nonzero exit, timeout and output limit are interpreted by
 * the adapter, which must redact all public diagnostics after parsing.
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
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new InvalidArgumentError("Tool timeout must be a positive bounded integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
    throw new InvalidArgumentError("Tool output limit must be a positive integer");
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
      reject(new ToolLaunchError(tool, `Cannot start ${command}: invalid arguments`));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
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
      resolve(result(null, "timeout"));
    }, timeoutMs);
    const result = (exitCode: number | null, interruption?: ToolRun["interruption"]): ToolRun => ({
      exitCode,
      stdout: decoder.decode(Buffer.concat(out)),
      stderr: decoder.decode(Buffer.concat(err)),
      ...(interruption === undefined ? {} : { interruption }),
    });
    const append = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      const available = maxOutputBytes - bytes;
      chunks.push(chunk.subarray(0, available));
      bytes += Math.min(available, chunk.length);
      if (chunk.length > available && settle()) {
        child.kill();
        resolve(result(null, "output-limit"));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      append(out, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(err, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Only the error code is kept: the error object lists the arguments (`spawnargs`).
      if (settle()) {
        reject(
          new ToolLaunchError(
            tool,
            maskSecrets(`Cannot start ${command}: ${error.code ?? "error"}`, secrets),
          ),
        );
      }
    });
    child.on("close", (exitCode: number | null) => {
      if (!settle()) return;
      resolve(result(exitCode));
    });
  });
}

/** Public diagnostic text only. Never pass protocol identifiers or enum values here. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter(Boolean))];
  if (!unique.length) return text;
  if (unique.length > 256 || unique.reduce((size, value) => size + value.length, 0) > 16384)
    return MASK;
  const variants = new Set<string>();
  for (const secret of unique) {
    let uri: string;
    try {
      uri = encodeURIComponent(secret);
    } catch {
      return MASK;
    }
    for (const value of [
      secret,
      decodeDiagnosticXml(secret),
      uri,
      uri.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      JSON.stringify(secret).slice(1, -1),
    ])
      variants.add(value);
  }
  const pattern = [...variants]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // One replacement pass: inserted markers are never interpreted as new secret matches.
  return decodeDiagnosticXml(text).replace(new RegExp(pattern, "g"), () => MASK);
}

/** Normalize XML entities in diagnostics, including the serializer's numeric CR/LF/TAB. */
function decodeDiagnosticXml(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|quot|apos|lt|gt);/g,
    (entity, code: string) => {
      if (!code.startsWith("#")) return named[code] ?? entity;
      const point = code.startsWith("#x")
        ? Number.parseInt(code.slice(2), 16)
        : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    },
  );
}
