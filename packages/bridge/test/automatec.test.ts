import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomateC } from "../src/automatec/client.js";
import {
  CommandFailedError,
  InvalidArgumentError,
  RunOutcomeUnknownError,
  ToolOutputLimitError,
  ToolTimeoutError,
} from "../src/errors.js";
import { runTool } from "../src/process.js";
import {
  parseExport,
  parseImport,
  parseListProcesses,
  parseLog,
  parsePublish,
  parseRequestStop,
  parseRun,
  parseStatus,
} from "../src/automatec/parsers.js";

vi.mock("../src/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/process.js")>()),
  runTool: vi.fn(),
}));
const exec = vi.mocked(runTool);
const id = "8c9c001d-12e0-4f5b-9a71-80af94a9bd15";
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures/automatec", `${name}.txt`), "utf8");
const credentials = (password = "secret&value") => ({
  getCredentials: () => Promise.resolve({ user: "tester", password }),
});
const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

beforeEach(() => exec.mockReset());

describe("AutomateC mutation outcomes", () => {
  it("targets the explicit runtime port and rejects invalid ports before native execution", async () => {
    exec.mockResolvedValue(ok(`Session: ${id}\n`));
    const automatec = new AutomateC({ credentials: credentials() });
    expect(await automatec.run("Demo", { resource: "Robot", port: 8182 })).toBe(id);
    const args = exec.mock.calls[0]?.[1] ?? [];
    expect(args.slice(args.indexOf("/port"), args.indexOf("/port") + 2)).toEqual(["/port", "8182"]);
    for (const port of [0, 65536, 1.5])
      await expect(automatec.run("Demo", { resource: "Robot", port })).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each(["timeout", "output-limit"] as const)(
    "retains an acknowledged session after %s",
    async (interruption) => {
      exec.mockResolvedValue({
        ...ok(`Session: ${id}\nsecret&value`),
        exitCode: null,
        interruption,
      });
      expect(
        await new AutomateC({ credentials: credentials() }).run("Demo", { resource: "Robot" }),
      ).toBe(id);
      expect(exec).toHaveBeenCalledTimes(1);
    },
  );
  it("retains a session even after nonzero exit", async () => {
    exec.mockResolvedValue({ ...ok(`Session: ${id}\n`), exitCode: 1 });
    expect(
      await new AutomateC({ credentials: credentials() }).run("Demo", { resource: "Robot" }),
    ).toBe(id);
  });
  it.each(["Session", "1", "e"])(
    "parses acknowledgement before masking password %s",
    async (password) => {
      exec.mockResolvedValue(ok(`Session: ${id}\n`));
      expect(
        await new AutomateC({ credentials: credentials(password) }).run("Demo", {
          resource: "Robot",
        }),
      ).toBe(id);
    },
  );
  it("reports unknown outcome, not safe-to-retry, when timeout has no acknowledgement", async () => {
    exec.mockResolvedValue({ ...ok("secret&value partial output"), interruption: "timeout" });
    const error: unknown = await new AutomateC({ credentials: credentials() })
      .run("Demo", { resource: "Robot" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunOutcomeUnknownError);
    expect(JSON.stringify(error)).not.toContain("secret&value");
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("recognizes a known refusal before session creation", async () => {
    exec.mockResolvedValue({ ...ok("Error: Resource does not exist\n"), exitCode: 1 });
    await expect(
      new AutomateC({ credentials: credentials() }).run("Demo", { resource: "Robot" }),
    ).rejects.toBeInstanceOf(CommandFailedError);
  });
  it("rejects option-like names without invoking the executable", async () => {
    await expect(
      new AutomateC({ credentials: credentials() }).run("/delete", { resource: "Robot" }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("public diagnostics", () => {
  it("creates a namespaced queue with the qualified native acknowledgement", async () => {
    exec.mockResolvedValue(ok(`Created queue: ${id}\r\n`));
    expect(
      await new AutomateC({ credentials: credentials() }).createQueue("BPDEV Queue", "CaseKey", 1),
    ).toBe(id);
    expect(exec.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["/createqueue", "CaseKey", "True", "1", "/queuename", "BPDEV Queue"]),
    );
  });
  it("refuses invalid queue parameters before invoking BP", async () => {
    await expect(
      new AutomateC({ credentials: credentials() }).createQueue("Production Queue"),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(exec).not.toHaveBeenCalled();
  });
  it("redacts XML-encoded known credentials in native log details", async () => {
    exec.mockResolvedValue(
      ok(
        `Log for session ${id}:\n2026-09-29 10:00:00,${id},Step,<value>secret&amp;value</value>\n`,
      ),
    );
    const log = await new AutomateC({ credentials: credentials() }).getLog(id);
    expect(log[0]?.result).toBe("<value>***</value>");
  });
  it("keeps status structural values intact even with a short secret", async () => {
    exec.mockResolvedValue(ok(`Session: ${id}\nStatus:Completed\n`));
    expect(await new AutomateC({ credentials: credentials("e") }).status(id)).toBe("Completed");
  });
  it.each(["timeout", "output-limit"] as const)(
    "redacts partial diagnostics on %s",
    async (interruption) => {
      exec.mockResolvedValue({ ...ok("secret&value"), interruption });
      const error: unknown = await new AutomateC({ credentials: credentials() })
        .status(id)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(
        interruption === "timeout" ? ToolTimeoutError : ToolOutputLimitError,
      );
      expect(JSON.stringify(error)).not.toContain("secret&value");
    },
  );
  it("redacts parser errors without keeping a raw cause", async () => {
    exec.mockResolvedValue(ok("unexpected secret&value"));
    const error: unknown = await new AutomateC({ credentials: credentials() })
      .status(id)
      .catch((e: unknown) => e);
    expect(String(error)).not.toContain("secret&value");
    expect(JSON.stringify(error)).not.toContain("secret&value");
  });
  it("carries startup password context into subsequent session logs", async () => {
    const client = new AutomateC({ credentials: credentials() });
    exec.mockResolvedValueOnce(ok(`Session: ${id}\n`));
    await client.run("Demo", {
      resource: "Robot",
      inputs: [{ name: "Token", type: "password", value: "input-secret" }],
    });
    exec.mockResolvedValueOnce(
      ok(`Log for session ${id}:\n2026-09-29 10:00:00,${id},Step,input-secret secret&value\n`),
    );
    const log = await client.getLog(id);
    expect(log[0]?.result).toBe("*** ***");
    expect(log[0]?.stageId).toBe(id);
  });
});

describe("captured protocol fixtures", () => {
  it("reads acknowledged runs, status and process lists", () => {
    expect(parseRun(fixture("run")).sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseStatus(fixture("status-completed"), id)).toBe("Completed");
    expect(parseListProcesses(fixture("listprocesses")).length).toBeGreaterThan(0);
  });
  it("recognizes native import/export/publish answers", () => {
    expect(() => {
      parseImport(fixture("import"));
    }).not.toThrow();
    expect(() => {
      parseExport(fixture("export"));
    }).not.toThrow();
    expect(parsePublish(fixture("publish-already"), "anything")).toBe("already-published");
  });
  it("reads multiline logs and rejects an unknown session", () => {
    expect(parseLog(fixture("getlog-echo"), id)).toHaveLength(7);
    expect(() => parseLog(fixture("getlog-unknown-session"), id)).toThrow();
  });
  it("requires the matching session on requeststop", () => {
    expect(() => {
      parseRequestStop(`Stop requested for session: ${id}\n`, id);
    }).not.toThrow();
    expect(() => parseStatus(fixture("status-invalid-id"), id)).toThrow();
  });
});
