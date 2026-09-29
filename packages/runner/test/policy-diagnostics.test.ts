import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectSpec } from "@bpdev/generator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLog } from "../../bridge/src/automatec/parsers.js";
import { DEFAULT_BROWSER_PATH, Runner, type BuildSpec } from "../src/index.js";
import { exceptionEvidence } from "../src/diagnostics.js";
import { applyPolicy, applyObjectPolicy } from "../src/policy.js";
import { cleanup, deployed, fixture, log, SESSION, spec, type Fixture } from "./helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup(f.directory);
});

function editedApplication(change: (object: ObjectSpec) => void): BuildSpec {
  const input = spec();
  const object = input.objects[0];
  if (!object) throw new Error("Fixture needs an object");
  change(object);
  return input;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

describe("model-to-browser product boundary", () => {
  it.each([
    ["ProcessID", "123"],
    ["Other", '"value"'],
    ["ProcessName", '"msedge"'],
    ["ProcessName", "[Browser]"],
    ["WindowTitle", '"*"'],
    ["WindowTitle", '"*Chrome*"'],
    ["WindowTitle", '"?Challenge*"'],
    ["WindowTitle", '"   *"'],
    ["WindowTitle", "[Title]"],
    ["WindowTitle", '"Rpa" & " Challenge*"'],
  ])("rejects unsafe ensureAttached argument %s = %s", (name, value) => {
    const input = editedApplication((object) => {
      object.actions.push({
        name: "Attach",
        description: "",
        inputs: [],
        outputs: [],
        steps: [
          {
            kind: "ensureAttached",
            args: { ProcessName: '"chrome"', WindowTitle: '"Rpa Challenge*"', [name]: value },
          },
        ],
      });
    });
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/Attach/);
  });

  it("requires an explicit Attach title even without an application title, and checks agreement", () => {
    const input = editedApplication((object) => {
      object.application = { kind: "BrowserAttach", name: "Browser" };
      object.actions.push({
        name: "Attach",
        description: "",
        inputs: [],
        outputs: [],
        steps: [{ kind: "ensureAttached", args: { ProcessName: '"chrome"' } }],
      });
    });
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/WindowTitle/);
    const object = input.objects[0];
    const attach = object?.actions.at(-1)?.steps[0];
    if (!object || attach?.kind !== "ensureAttached") throw new Error("Missing attach");
    attach.args = { ProcessName: '"chrome"', WindowTitle: '"Rpa Challenge*"' };
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).not.toThrow();
    object.application = {
      kind: "BrowserAttach",
      name: "Browser",
      parameters: { WindowTitle: "Other site*" },
    };
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/match/);
  });
  it.each([
    { browserPath: "C:\\Windows\\System32\\cmd.exe" },
    { browserPath: "chrome.exe" },
    { extraArgs: ["--load-extension=C:\\arbitrary"] },
    { extraArgs: ["--user-data-dir=C:\\personal-profile"] },
    { extraArgs: ["--remote-debugging-port=9222"] },
    { extraArgs: ["--user-data-dir={robotProfileDir}", '--user-data-dir="{robotProfileDir}"'] },
    { url: "javascript:alert(1)" },
    { url: "file:///C:/private" },
    { url: "https://user:password@example.invalid/" },
    { url: 'https://example.invalid/ --load-extension="C:\\arbitrary"' },
    { url: "https://example.invalid/\n--no-sandbox" },
  ])("rejects unsupported launch configuration %j before native calls", async (override) => {
    const input = editedApplication((object) => {
      object.application = {
        kind: "BrowserLaunch",
        name: "Browser",
        browserPath: DEFAULT_BROWSER_PATH,
        url: "https://example.invalid/",
        ...override,
      };
    });
    await expect(f.runner.prepare(input)).rejects.toMatchObject({ code: "UNSUPPORTED_SPEC" });
    expect(f.fake.automatec.run).not.toHaveBeenCalled();
    expect(f.fake.probe.validate).not.toHaveBeenCalled();
  });

  it("enforces the configured executable and always quotes the dedicated profile", async () => {
    const configured = "D:\\Approved Browser\\chrome.exe";
    const runner = new Runner({ ...f.options, browserPath: configured });
    const input = editedApplication((object) => {
      object.application = {
        kind: "BrowserLaunch",
        name: "Browser",
        browserPath: configured,
        url: "https://example.invalid/?a=b",
        extraArgs: ["--no-first-run", "--user-data-dir={robotProfileDir}"],
      };
    });
    const before = structuredClone(input);
    const artifact = await runner.prepare(input);
    const xml = await f.store.text("artifacts", artifact.artifactId, "object-0.bpobject");
    expect(xml).toContain('--user-data-dir="C:\\Robot Profiles\\Unit Test"');
    expect(xml).toContain(configured);
    expect(xml).toContain("--no-first-run --no-default-browser-check");
    expect(input).toEqual(before);
    await expect(runner.prepare(spec())).rejects.toMatchObject({ code: "UNSUPPORTED_SPEC" });
  });

  it.each([
    ["CommandLineParams", "javascript:alert(1)"],
    ["Path", "C:\\Windows\\System32\\cmd.exe"],
    ["ProcessMode", "External"],
    ["UnknownExecutableParam", "C:\\shell.exe"],
  ])("rejects unsupported Attach parameter %s", async (name, value) => {
    const parameters = { [name]: value };
    const input = editedApplication((object) => {
      object.application = { kind: "BrowserAttach", name: "Browser", parameters };
    });
    await expect(f.runner.prepare(input)).rejects.toMatchObject({ code: "UNSUPPORTED_SPEC" });
  });

  it.each(["WebExecuteJavaScript", "WebInvokeJavascriptFunction", "Evaluate", "SendKeys"])(
    "forbids executable operation %s even before catalog resolution",
    async (action) => {
      const input = editedApplication((object) => {
        object.elements = [
          { key: "target", name: "Target", type: "WebElement", match: { wId: "target" } },
        ];
        const observe = object.actions[0];
        if (!observe) throw new Error("Missing action");
        observe.steps = [{ kind: "act", action, element: "target" }];
      });
      await expect(f.runner.prepare(input)).rejects.toMatchObject({ code: "UNSUPPORTED_SPEC" });
      expect(f.fake.probe.validate).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact two-object examples within the configured boundary", async () => {
    const examples = join(import.meta.dirname, "../../generator/examples");
    const basic = JSON.parse(
      await readFile(join(examples, "rpa-challenge.basic-actions.object.json"), "utf8"),
    ) as ObjectSpec;
    const form = JSON.parse(
      await readFile(join(examples, "rpa-challenge.form.object.json"), "utf8"),
    ) as ObjectSpec;
    const artifact = await f.runner.prepare({
      objects: [basic, form],
      harness: {
        object: form.name,
        calls: [{ object: basic.name, action: "Launch" }, { action: "Click Button - Start" }],
        cleanupAction: "Terminate",
        cleanupObject: basic.name,
      },
    });
    expect(artifact.files.map((file) => file.kind)).toEqual(["object", "object", "process"]);
  });
});

function waitSpec(timeoutSeconds: number | string = "[Wait Timeout]"): BuildSpec {
  return editedApplication((object) => {
    const action = object.actions[0];
    if (!action) throw new Error("Missing action");
    object.elements = [
      { key: "target", name: "Target", type: "WebElement", match: { wId: "target" } },
    ];
    action.inputs = [{ name: "Wait Timeout", type: "number", description: "", defaultValue: 5 }];
    action.steps.unshift({
      kind: "waitFor",
      element: "target",
      timeoutSeconds,
      onTimeout: { type: "System Exception", detail: "Timeout" },
    });
  });
}

describe("bounded waits and early input limits", () => {
  it.each([0, -1, 120.001, Infinity, NaN, "999", "[Wait Timeout] + 1"])(
    "rejects timeout %s",
    (timeout) => {
      expect(() => applyPolicy(waitSpec(timeout), DEFAULT_BROWSER_PATH)).toThrow();
    },
  );
  it.each([0.01, 120])("accepts literal boundary %s", (timeout) => {
    expect(() => applyPolicy(waitSpec(timeout), DEFAULT_BROWSER_PATH)).not.toThrow();
  });
  it.each([undefined, 0, 121, "5", true])("rejects unsafe default %s", (value) => {
    const input = waitSpec();
    const param = input.objects[0]?.actions[0]?.inputs[0];
    if (!param) throw new Error("Missing parameter");
    if (value === undefined) delete param.defaultValue;
    else param.defaultValue = value;
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/numeric default/);
  });
  it.each(["999", "0", "[Other]", "5 + 200"])("rejects harness override %s", (value) => {
    const input = waitSpec();
    required(input.harness.calls[0]).inputs = { "Wait Timeout": value };
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/overrides/);
  });
  it("keeps bounded explicit overrides and parameter forwarding unchanged", () => {
    const input = waitSpec();
    const object = required(input.objects[0]);
    object.actions.push({
      name: "Caller",
      description: "",
      inputs: [{ name: "Budget", type: "number", defaultValue: 12, description: "" }],
      outputs: [],
      steps: [{ kind: "callPage", page: "Observe", inputs: { "Wait Timeout": "[Budget]" } }],
    });
    input.harness.calls = [{ action: "Caller", inputs: { Budget: "120" } }];
    const checked = applyPolicy(input, DEFAULT_BROWSER_PATH);
    expect(checked.objects[0]?.actions).toEqual(object.actions);
    expect(checked.harness).toEqual(input.harness);
    required(input.harness.calls[0]).inputs = { Budget: "121" };
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/overrides/);
  });
  it.each(["calc", "read", "callPage", "output"])("rejects timeout mutation via %s", (kind) => {
    const input = waitSpec();
    const action = required(required(input.objects[0]).actions[0]);
    if (kind === "output")
      action.outputs.push({ name: "Wait Timeout", type: "number", description: "" });
    if (kind === "calc")
      action.steps.push({ kind: "calc", into: "Wait Timeout", expression: "999" });
    if (kind === "read")
      action.steps.push({
        kind: "read",
        into: "Wait Timeout",
        element: "target",
        action: "WebGetText",
      });
    if (kind === "callPage")
      action.steps.push({ kind: "callPage", page: "Finish", outputs: { Result: "Wait Timeout" } });
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/Wait parameter/);
  });
  it("fails closed for standalone object builders without a complete caller list", () => {
    expect(() => applyObjectPolicy(waitSpec().objects, DEFAULT_BROWSER_PATH)).toThrow(
      /caller list/,
    );
    expect(() => applyObjectPolicy(waitSpec(5).objects, DEFAULT_BROWSER_PATH)).not.toThrow();
  });
  it.each(["actions", "steps", "inputs", "elements"] as const)(
    "enforces the %s array boundary",
    (key) => {
      const input = waitSpec(5);
      const object = required(input.objects[0]);
      const action = required(object.actions[0]);
      const limit = key === "steps" || key === "elements" ? 200 : 100;
      if (key === "actions")
        object.actions = Array.from({ length: limit }, (_, i) => ({
          ...action,
          name: `Action ${i}`,
        }));
      if (key === "steps")
        action.steps = Array.from({ length: limit }, () => ({
          kind: "calc",
          expression: '"ok"',
          into: "Answer",
        }));
      if (key === "inputs")
        action.inputs = Array.from({ length: limit }, (_, i) => ({
          name: `Input ${i}`,
          type: "text",
          description: "",
        }));
      if (key === "elements")
        object.elements = Array.from({ length: limit }, (_, i) => ({
          key: `item${i}`,
          name: `Item ${i}`,
          type: "WebElement",
          match: { wId: `item${i}` },
        }));
      expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).not.toThrow();
      const array =
        key === "actions" ? object.actions : key === "elements" ? object.elements : action[key];
      array.length = limit + 1;
      expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/array exceeds/);
    },
  );
  it("measures JSON in UTF-8 bytes and rejects size before schema parsing", () => {
    const input = spec();
    const object = required(input.objects[0]);
    object.description = "";
    const base = Buffer.byteLength(JSON.stringify(input), "utf8");
    object.description = "a".repeat(512 * 1024 - base);
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).not.toThrow();
    object.description += "é";
    expect(() => applyPolicy(input, DEFAULT_BROWSER_PATH)).toThrow(/512 KiB/);
    expect(() => applyPolicy({ ...input, extra: true } as BuildSpec, DEFAULT_BROWSER_PATH)).toThrow(
      /512 KiB/,
    );
  });
});

describe("confirmed exception evidence from the full native log", () => {
  it("captures the first logged exception before pagination and distinct cleanup failure", async () => {
    const artifact = await deployed(f);
    const run = await f.runner.start(artifact.artifactId, "diagnostics");
    const raw = await readFile(
      join(import.meta.dirname, "../../bridge/test/fixtures/automatec/getlog-failed.txt"),
      "utf8",
    );
    const entries = parseLog(raw, "2d1a74d6-b4f6-4ef7-a6e3-1b8da0119b9f");
    entries.push({
      ...log(99),
      stageName: "Finish After Error",
      result: "ERROR: Internal Exception : Cleanup failed",
    });
    f.fake.automatec.status.mockResolvedValue("Failed");
    f.fake.automatec.getLog.mockResolvedValue(entries);
    const observed = await f.runner.inspect(run.runId, 0, 1);
    expect(observed.logs).toHaveLength(1);
    expect(observed.run.logEvidence).toMatchObject({
      source: "AutomateC/getLog",
      scope: "logged-exceptions-only",
      bpSessionId: SESSION,
      logCount: entries.length,
      firstLoggedException: {
        logIndex: 8,
        stageName: "Wait for Home - Not Found",
        exceptionType: "System Exception",
        detail: "RPA Challenge home page did not load",
      },
      subsequentLoggedExceptions: [
        {
          stageName: "Finish After Error",
          exceptionType: "Internal Exception",
          detail: "Cleanup failed",
        },
      ],
    });
    f.fake.automatec.getLog.mockRejectedValueOnce(new Error("Unavailable"));
    const cached = await new Runner(f.options).inspect(run.runId, 1, 1);
    expect(cached.observationHealth).toBe("unavailable");
    expect(cached.run.logEvidence).toEqual(observed.run.logEvidence);
  });

  it("does not infer exceptions from broad error substrings or timeout messages", () => {
    const rows = [
      "No error",
      "ERROR: not the native grammar",
      "User says ERROR: System Exception : not at start",
      "(2) Wait - Time Out",
      "error: System Exception : wrong casing",
    ];
    const evidence = exceptionEvidence(
      rows.map((result, index) => ({ ...log(index), result })),
      SESSION,
      "2026-09-29T00:00:00Z",
    );
    expect(evidence.firstLoggedException).toBeUndefined();
    expect(evidence.subsequentLoggedExceptions).toEqual([]);
  });

  it("bounds cached exception count/details and declares truncation", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      ...log(index),
      result: `ERROR: System Exception : ${index} ${"x".repeat(9000)}`,
    }));
    const evidence = exceptionEvidence(rows, SESSION, "2026-09-29T00:00:00Z");
    expect(evidence.truncated).toBe(true);
    expect(evidence.firstLoggedException?.detail).toHaveLength(8192);
    expect(evidence.subsequentLoggedExceptions).toHaveLength(19);
  });
});
