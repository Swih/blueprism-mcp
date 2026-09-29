import { describe, expect, it } from "vitest";
import { InvalidArgumentError, ToolLaunchError } from "../src/errors.js";
import { maskSecrets, runTool } from "../src/process.js";
import { buildStartupInputs } from "../src/automatec/inputs.js";

const options = { tool: "AutomateC" as const, command: "/run", encoding: "utf-8", timeoutMs: 500 };

describe("diagnostic secret redaction", () => {
  it("masks the startup serializer's XML encoding, including CR/LF/TAB", () => {
    const secret = 'synthetic\r\n\t<&"credential';
    const xml = buildStartupInputs([{ name: "Token", type: "password", value: secret }]);
    expect(xml).toContain("&#xA;");
    expect(maskSecrets(xml, [secret])).toContain('value="***"');
    expect(maskSecrets(xml, [secret])).not.toContain("synthetic");
  });
  it("recognizes mixed numeric XML entities and JSON/URI encoding", () => {
    const secret = 'a&"b\\c';
    for (const value of [
      secret,
      "a&#38;&#x22;b\\c",
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%[A-F0-9]{2}/g, (s) => s.toLowerCase()),
    ])
      expect(maskSecrets(value, [secret])).toBe("***");
  });
  it("never remasks inserted markers, even with duplicate short secrets", () => {
    expect(maskSecrets("*", Array<string>(100).fill("*"))).toBe("***");
    expect(maskSecrets("foobar foo", ["foo", "foobar", "*"])).toBe("*** ***");
    expect(maskSecrets("secret", ["secret", "*"])).toBe("***");
  });
  it("withholds text when redaction context is excessive or malformed", () => {
    expect(maskSecrets("private diagnostic", ["x".repeat(16385)])).toBe("***");
    expect(maskSecrets("private diagnostic", ["\ud800"])).toBe("***");
    expect(maskSecrets("unchanged &amp;", [""])).toBe("unchanged &amp;");
  });
});

describe("bounded internal process transport", () => {
  it("preserves partial protocol output on timeout without claiming robot failure", async () => {
    const run = await runTool(
      process.execPath,
      [
        "-e",
        "process.stdout.write('Session: 12345678-1234-1234-1234-123456789abc\\n'); setInterval(()=>{},1000)",
      ],
      options,
    );
    expect(run.interruption).toBe("timeout");
    expect(run.stdout).toContain("Session: 12345678-1234-1234-1234-123456789abc");
  });
  it("enforces a combined output budget and marks interruption", async () => {
    const run = await runTool(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(50000)); setInterval(()=>{},1000)"],
      { ...options, maxOutputBytes: 64 },
    );
    expect(run.interruption).toBe("output-limit");
    expect(Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr)).toBeLessThanOrEqual(64);
  });
  it("keeps raw protocol private so secrets cannot corrupt parsing", async () => {
    const run = await runTool(process.execPath, ["-e", "process.stdout.write('Session: value')"], {
      ...options,
      secrets: ["Session"],
    });
    expect(run.stdout).toBe("Session: value");
  });
  it("does not leak invalid argument contents in launch errors", async () => {
    const error: unknown = await runTool(process.execPath, ["secret\0value"], options).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ToolLaunchError);
    expect(JSON.stringify(error)).not.toContain("secret");
  });
  it("rejects invalid bounds before spawning", () => {
    expect(() => runTool(process.execPath, [], { ...options, timeoutMs: 0 })).toThrow(
      InvalidArgumentError,
    );
  });
});
