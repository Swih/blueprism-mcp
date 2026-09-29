import { resolve } from "node:path";
import {
  CommandFailedError,
  ToolOutputLimitError,
  ToolTimeoutError,
  UnexpectedOutputError,
} from "./errors.js";
import { runTool } from "./process.js";

export interface NativeValidation {
  readonly level: "native-parse";
  readonly valid: boolean;
  readonly name?: string;
  readonly nameSha256?: string;
  readonly expressionsChecked?: number;
  readonly kind?: string;
  readonly stages?: number;
  readonly reason?: string;
}

/** Uses installed parsing/expression checks; external dependencies still require Studio. */
export class NativeProbe {
  constructor(private readonly options: { readonly path: string; readonly timeoutMs?: number }) {}

  async validate(file: string): Promise<NativeValidation> {
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const result = await runTool(this.options.path, ["validate", resolve(file)], {
      tool: "bpprobe",
      command: "validate",
      timeoutMs,
      encoding: "utf-8",
      maxOutputBytes: 1024 * 1024,
    });
    // A native exception may contain the source XML. Never forward it to a model or logger.
    if (result.interruption === "timeout")
      throw new ToolTimeoutError("bpprobe", "validate", timeoutMs);
    if (result.interruption === "output-limit")
      throw new ToolOutputLimitError("bpprobe", "validate", "");
    if (result.stdout.startsWith("INVALID:"))
      return {
        level: "native-parse",
        valid: false,
        reason: "Installed Blue Prism parser or expression validator rejected this artifact",
      };
    if (result.exitCode !== 0)
      throw new CommandFailedError("bpprobe", "validate", "Native probe failed", result.exitCode);
    const match = /^OK: (name|name-sha256)=(.+) type=(\w+) stages=(\d+)\r?$/m.exec(result.stdout);
    if (!match)
      throw new UnexpectedOutputError("bpprobe", "validate", "", "missing native parser summary");
    if (match[1] === "name-sha256" && !/^[0-9a-f]{64}$/.test(match[2] ?? ""))
      throw new UnexpectedOutputError("bpprobe", "validate", "", "invalid native identity digest");
    const expressions =
      /^Offline expressions: checked=(\d+) optional-empty=\d+ unsupported=0\./m.exec(result.stdout);
    return {
      level: "native-parse",
      valid: true,
      ...(match[1] === "name-sha256" ? { nameSha256: match[2] } : { name: match[2] }),
      ...(expressions ? { expressionsChecked: Number(expressions[1]) } : {}),
      kind: match[3],
      stages: Number(match[4]),
    };
  }
}
