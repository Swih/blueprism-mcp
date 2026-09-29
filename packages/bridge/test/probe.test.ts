import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeProbe } from "../src/probe.js";
import { runTool } from "../src/process.js";
vi.mock("../src/process.js", () => ({ runTool: vi.fn() }));

describe("installed parser adapter", () => {
  it("reads a digest identity and explicit expression qualification without source names", async () => {
    vi.mocked(runTool).mockResolvedValue({
      exitCode: 0,
      stdout: `OK: name-sha256=${"a".repeat(64)} type=Process stages=154\nOffline expressions: checked=64 optional-empty=2 unsupported=0. Not full Studio/dependency/runtime validation.\n`,
      stderr: "",
    });
    expect(await new NativeProbe({ path: "probe.exe" }).validate("test.bpprocess")).toEqual({
      valid: true,
      level: "native-parse",
      nameSha256: "a".repeat(64),
      kind: "Process",
      stages: 154,
      expressionsChecked: 64,
    });
  });
  it("does not promote legacy XML loading to expression validation", async () => {
    vi.mocked(runTool).mockResolvedValue({
      exitCode: 0,
      stdout: "OK: name=Test type=Process stages=2\n",
      stderr: "",
    });
    const result = await new NativeProbe({ path: "probe.exe" }).validate("test.bpprocess");
    expect(result.expressionsChecked).toBeUndefined();
  });
  it("rejects malformed identity digests without exposing their contents", async () => {
    vi.mocked(runTool).mockResolvedValue({
      exitCode: 0,
      stdout: "OK: name-sha256=synthetic-secret type=Process stages=2\n",
      stderr: "",
    });
    await expect(new NativeProbe({ path: "probe.exe" }).validate("test.bpprocess")).rejects.toThrow(
      "invalid native identity digest",
    );
  });
  it.each(["validate-process-ok", "validate-object-ok", "validate-object-app-stages-ok"])(
    "uses the captured %s contract",
    async (name) => {
      vi.mocked(runTool).mockResolvedValue({
        exitCode: 0,
        stdout: readFileSync(join(import.meta.dirname, `fixtures/bpprobe/${name}.txt`), "utf8"),
        stderr: "",
      });
      expect(await new NativeProbe({ path: "probe.exe" }).validate("test.bpobject")).toMatchObject({
        valid: true,
        level: "native-parse",
      });
    },
  );
  it("does not expose XML fragments from parser exceptions", async () => {
    vi.mocked(runTool).mockResolvedValue({
      exitCode: 1,
      stdout: "INVALID: bad input <password>synthetic-secret</password>",
      stderr: "",
    });
    const result = await new NativeProbe({ path: "probe.exe" }).validate("test.bpobject");
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
});
