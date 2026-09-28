import { firstChild, getAttr, listStages, parseBpXml, type BpElement } from "@bpdev/model";
import { describe, expect, it } from "vitest";
import {
  generateTestHarness,
  SpecValidationError,
  type ActionSpec,
  type ObjectSpec,
  type TestHarnessSpec,
} from "../src/index.js";
import { resolveHarness } from "../src/resolve-harness.js";
import { catalog, descendants, stageNamed } from "./helpers.js";

function action(name: string, overrides: Partial<ActionSpec> = {}): ActionSpec {
  return { name, description: "", inputs: [], outputs: [], steps: [], ...overrides };
}

function object(name: string, actions: ActionSpec[]): ObjectSpec {
  return {
    name,
    description: "Hand-written multi-object fixture",
    runMode: "Foreground",
    application: {
      kind: "BrowserLaunch",
      name: "Fixture browser",
      browserPath: "C:\\browser.exe",
      url: "https://example.invalid/",
    },
    elements: [],
    actions,
  };
}

function fixture() {
  const basic = object("Basic Actions", [
    action("Launch", { steps: [{ kind: "launch" }] }),
    action("Terminate", { steps: [{ kind: "close" }] }),
    action("Fill", {
      inputs: [{ name: "Count", type: "number", description: "", defaultValue: 0 }],
    }),
    action("Private", { published: false }),
  ]);
  const form = object("Form", [
    action("Fill", {
      inputs: [
        { name: "Value", type: "text", description: "" },
        { name: "Wait Timeout", type: "number", description: "", defaultValue: 5 },
      ],
      outputs: [{ name: "Actual Value", type: "text", description: "" }],
      steps: [{ kind: "calc", expression: "[Value]", into: "Actual Value" }],
    }),
    action("Terminate", { steps: [{ kind: "close" }] }),
  ]);
  const harness: TestHarnessSpec = {
    object: form.name,
    calls: [
      { object: basic.name, action: "Launch" },
      { action: "Fill", inputs: { Value: '"first"' } },
      { action: "Fill", inputs: { Value: '"last"' }, expect: { "Actual Value": "last" } },
    ],
    cleanupObject: basic.name,
    cleanupAction: "Terminate",
  };
  const objects: readonly ObjectSpec[] = [form, basic];
  return { form, basic, harness, objects };
}

function child(parent: BpElement, name: string): BpElement {
  const found = firstChild(parent, name);
  if (!found) throw new Error(`Missing <${name}> in <${parent.name}>`);
  return found;
}

function resource(stage: BpElement): (string | undefined)[] {
  const target = child(stage, "resource");
  return [getAttr(target, "object"), getAttr(target, "action")];
}

function issuesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof SpecValidationError)
      return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  throw new Error("Expected SpecValidationError");
}

describe("multi-object harness resources and flow", () => {
  it("launches the lifecycle object, calls the primary form, and binds only expected outputs", () => {
    const { harness, objects } = fixture();
    const generated = generateTestHarness(harness, objects, catalog);
    const root = parseBpXml(generated.xml).root;
    const launch = stageNamed(root, "Launch");
    const first = stageNamed(root, "Fill");
    const last = stageNamed(root, "Fill 2");
    expect(generated.name).toBe("Form - Test");
    expect(resource(launch.element)).toEqual(["Basic Actions", "Launch"]);
    expect(resource(first.element)).toEqual(["Form", "Fill"]);
    expect(resource(last.element)).toEqual(["Form", "Fill"]);
    expect(stageNamed(root, "Start").onSuccess).toBe(launch.id);
    expect(launch.onSuccess).toBe(first.id);
    expect(first.onSuccess).toBe(last.id);
    expect(last.onSuccess).toBe(stageNamed(root, "End").id);
    expect(descendants(first.element, "output")).toEqual([]);
    expect(
      descendants(last.element, "output").map((p) => [
        getAttr(p, "name"),
        getAttr(p, "type"),
        getAttr(p, "stage"),
      ]),
    ).toEqual([["Actual Value", "text", "Actual Value"]]);
    expect(
      listStages(root)
        .filter((s) => s.type === "Data")
        .map((s) => s.name),
    ).toEqual(["Actual Value"]);
    expect(
      descendants(stageNamed(root, "End").element, "output").map((p) => getAttr(p, "name")),
    ).toEqual(["Actual Value"]);
    expect(
      descendants(last.element, "input").map((p) => [getAttr(p, "name"), getAttr(p, "expr")]),
    ).toEqual([
      ["Value", '"last"'],
      ["Wait Timeout", "5"],
    ]);
  });

  it("keeps recovery active through cleanup and rethrows without a Resume or a loop", () => {
    const { harness, objects } = fixture();
    const root = parseBpXml(generateTestHarness(harness, objects, catalog).xml).root;
    const recover = stageNamed(root, "Recover");
    const cleanup = stageNamed(root, "Terminate After Error");
    const rethrow = stageNamed(root, "Rethrow");
    expect(recover.type).toBe("Recover");
    expect(cleanup.type).toBe("Action");
    expect(rethrow.type).toBe("Exception");
    expect(recover.onSuccess).toBe(cleanup.id);
    expect(cleanup.onSuccess).toBe(rethrow.id);
    expect(rethrow.onSuccess).toBeUndefined();
    expect(rethrow.onTrue).toBeUndefined();
    expect(rethrow.onFalse).toBeUndefined();
    expect(resource(cleanup.element)).toEqual(["Basic Actions", "Terminate"]);
    expect(getAttr(child(rethrow.element, "exception"), "usecurrent")).toBe("yes");
    expect(getAttr(child(rethrow.element, "exception"), "type")).toBe("");
    expect(getAttr(child(rethrow.element, "exception"), "detail")).toBe("");
    expect(listStages(root).filter((s) => s.type === "Resume")).toEqual([]);
    expect(stageNamed(root, "End").onSuccess).toBeUndefined();
  });

  it("resolves identical action names against their own object signatures", () => {
    const { harness, objects } = fixture();
    harness.calls = [
      { object: "Basic Actions", action: "Fill" },
      { action: "Fill", inputs: { Value: '"form"' }, expect: { "Actual Value": "form" } },
    ];
    const plan = resolveHarness(harness, objects);
    expect(plan.calls.map((c) => [c.object, c.action.name])).toEqual([
      ["Basic Actions", "Fill"],
      ["Form", "Fill"],
    ]);
    expect(plan.calls.map((c) => c.inputs.map((p) => [p.name, p.dataType, p.expression]))).toEqual([
      [["Count", "number", "0"]],
      [
        ["Value", "text", '"form"'],
        ["Wait Timeout", "number", "5"],
      ],
    ]);
    const root = parseBpXml(generateTestHarness(harness, objects, catalog).xml).root;
    expect(resource(stageNamed(root, "Fill").element)).toEqual(["Basic Actions", "Fill"]);
    expect(resource(stageNamed(root, "Fill 2").element)).toEqual(["Form", "Fill"]);
    const ids = listStages(root).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults call and cleanup objects to the primary object for both supported argument forms", () => {
    const { form } = fixture();
    const harness: TestHarnessSpec = {
      object: form.name,
      calls: [{ action: "Fill", inputs: { Value: '"single"' } }],
      cleanupAction: "Terminate",
    };
    const single = generateTestHarness(harness, form, catalog);
    expect(generateTestHarness(harness, [form], catalog).xml).toBe(single.xml);
    expect(resolveHarness(harness, form)).toEqual(resolveHarness(harness, [form]));
    const plan = resolveHarness(harness, form);
    expect(plan.object).toBe("Form");
    expect(plan.cleanupObject).toBe("Form");
    expect(plan.calls.map((c) => c.object)).toEqual(["Form"]);
    const root = parseBpXml(single.xml).root;
    expect(resource(stageNamed(root, "Terminate After Error").element)).toEqual([
      "Form",
      "Terminate",
    ]);
  });

  it("uses an optional name for the process without changing object resolution", () => {
    const { harness, objects } = fixture();
    const baseline = generateTestHarness(harness, objects, catalog);
    harness.name = "Two-object negative scenario";
    const renamed = generateTestHarness(harness, objects, catalog);
    const root = parseBpXml(renamed.xml).root;
    expect(renamed.name).toBe(harness.name);
    expect(renamed.fileName).toBe("Two-object negative scenario.bpprocess");
    expect(getAttr(root, "name")).toBe(harness.name);
    expect(getAttr(root, "preferredid")).not.toBe(
      getAttr(parseBpXml(baseline.xml).root, "preferredid"),
    );
    expect(resolveHarness(harness, objects).object).toBe("Form");
    expect(resource(stageNamed(root, "Launch").element)).toEqual(["Basic Actions", "Launch"]);
    expect(resource(stageNamed(root, "Fill").element)).toEqual(["Form", "Fill"]);
  });

  it("is deterministic across object inventory order and leaves all inputs untouched", () => {
    const { harness, objects } = fixture();
    const before = structuredClone({ harness, objects });
    const first = generateTestHarness(harness, objects, catalog).xml;
    expect(generateTestHarness(harness, [...objects].reverse(), catalog).xml).toBe(first);
    expect(generateTestHarness(harness, objects, catalog).xml).toBe(first);
    expect({ harness, objects }).toEqual(before);
  });
});

describe("multi-object harness validation", () => {
  it.each(["primary", "call", "cleanup"] as const)("rejects an unavailable %s object", (which) => {
    const { harness, objects } = fixture();
    if (which === "primary") harness.object = "Missing";
    if (which === "call") harness.calls = [{ object: "Missing", action: "Launch" }];
    if (which === "cleanup") harness.cleanupObject = "Missing";
    const issues = issuesOf(() => generateTestHarness(harness, objects, catalog));
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/object "Missing" was not supplied/)]),
    );
    const path =
      which === "primary"
        ? /^object:/
        : which === "call"
          ? /^calls\[0\].*\.object:/
          : /^cleanupObject:/;
    expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(path)]));
  });

  it("rejects an empty object inventory", () => {
    const { harness } = fixture();
    expect(issuesOf(() => generateTestHarness(harness, [], catalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^object:.*objects: none/)]),
    );
  });

  it("rejects duplicate object names even when both entries are the same spec", () => {
    const { harness, objects, basic } = fixture();
    expect(issuesOf(() => generateTestHarness(harness, [...objects, basic], catalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/objects\[2\]\.name: duplicate object name "Basic Actions"/),
      ]),
    );
  });

  it("does not search other objects when an action is absent from the selected object", () => {
    const { harness, objects } = fixture();
    harness.calls = [{ action: "Launch" }];
    expect(issuesOf(() => generateTestHarness(harness, objects, catalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/"Launch" is not an action of Form/)]),
    );
  });

  it("validates an override's signature rather than the same-named primary action", () => {
    const { harness, objects } = fixture();
    harness.calls = [
      { object: "Basic Actions", action: "Fill", inputs: { Value: '"wrong owner"' } },
    ];
    expect(issuesOf(() => generateTestHarness(harness, objects, catalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.inputs\.Value: not an input.*Count/)]),
    );
  });

  it("rejects a private action selected on a secondary object", () => {
    const { harness, objects } = fixture();
    harness.calls = [{ object: "Basic Actions", action: "Private" }];
    expect(issuesOf(() => generateTestHarness(harness, objects, catalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.action: "Private" is a private helper page/),
      ]),
    );
  });

  it.each(["private", "inputs", "missing"] as const)(
    "validates %s cleanup on its selected object",
    (kind) => {
      const { harness, objects } = fixture();
      harness.cleanupAction =
        kind === "private" ? "Private" : kind === "inputs" ? "Fill" : "Missing";
      const message =
        kind === "private"
          ? /private helper page/
          : kind === "inputs"
            ? /takes inputs/
            : /not an action of Basic Actions/;
      const issues = issuesOf(() => generateTestHarness(harness, objects, catalog));
      expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/^cleanupAction:/)]));
      expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
    },
  );

  it("checks expected outputs against the selected action", () => {
    const { harness, objects } = fixture();
    harness.calls = [
      { object: "Basic Actions", action: "Fill", expect: { "Actual Value": "wrong" } },
    ];
    expect(issuesOf(() => generateTestHarness(harness, objects, catalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.expect\.Actual Value: not an output.*none/),
      ]),
    );
  });

  it("preserves rejection of repeated expected output bindings", () => {
    const { harness, objects } = fixture();
    harness.calls = [1, 2].map(() => ({
      action: "Fill",
      inputs: { Value: '"x"' },
      expect: { "Actual Value": "x" },
    }));
    expect(issuesOf(() => generateTestHarness(harness, objects, catalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/already expected from an earlier call/)]),
    );
  });

  it("parses and resolves every supplied spec, including unused objects", () => {
    const { harness, objects } = fixture();
    const malformed = { ...object("Unused", []), unsupported: true };
    expect(() => generateTestHarness(harness, [...objects, malformed], catalog)).toThrow(
      SpecValidationError,
    );
    const invalid = object("Unused", [
      action("Invalid", {
        steps: [{ kind: "act", element: "undeclared", action: "WebClick" }],
      }),
    ]);
    expect(issuesOf(() => generateTestHarness(harness, [...objects, invalid], catalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/element "undeclared" is not declared/)]),
    );
  });

  it("rejects an empty explicit process name", () => {
    const { harness, objects } = fixture();
    harness.name = "";
    expect(issuesOf(() => generateTestHarness(harness, objects, catalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^name:/)]),
    );
  });
});
