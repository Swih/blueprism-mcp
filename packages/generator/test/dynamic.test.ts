import type { Catalog, ElementTypeInfo } from "@bpdev/catalog";
import {
  childElements,
  childText,
  firstChild,
  getAttr,
  listAppElements,
  listStages,
  parseBpXml,
  serializeBpXml,
  type BpElement,
} from "@bpdev/model";
import { describe, expect, it } from "vitest";
import {
  generateObject,
  generateTestHarness,
  SpecValidationError,
  type ActionSpec,
  type ObjectSpec,
  type ParamSpec,
  type StepSpec,
  type TestHarnessSpec,
} from "../src/index.js";
import { catalog, descendants, pageId, stageNamed, stagesOfPage } from "./helpers.js";

// Extend only the hand-written test catalog, in memory. No examples or reference exports.
function attachmentCatalog(): Catalog {
  const application = catalog.elementType("Application", "BrowserAttach");
  if (!application) throw new Error("The test catalog needs Application");
  const extended: ElementTypeInfo = {
    ...application,
    actions: [
      ...application.actions.filter((op) => op.id !== "AttachApplication"),
      {
        id: "AttachApplication",
        returns: "",
        arguments: [
          { id: "WindowTitle", dataType: "text" },
          { id: "trackingid", dataType: "text" },
        ],
        outputs: [],
      },
    ],
    readActions: [
      ...application.readActions.filter((op) => op.id !== "IsConnected"),
      {
        id: "IsConnected",
        returns: "flag",
        arguments: [{ id: "trackingid", dataType: "text" }],
        outputs: [],
      },
    ],
  };
  return {
    ...catalog,
    elementType: (id: string, applicationKind?: string) =>
      id === "Application" && applicationKind === "BrowserAttach"
        ? extended
        : catalog.elementType(id, applicationKind),
  };
}

const dynamicCatalog = attachmentCatalog();
type WaitStep = Extract<StepSpec, { kind: "waitFor" }>;
type CallStep = Extract<StepSpec, { kind: "callPage" }>;
type ElementStep = Extract<StepSpec, { kind: "waitFor" | "write" | "read" | "act" }>;

function param(
  name: string,
  type: ParamSpec["type"],
  defaultValue?: ParamSpec["defaultValue"],
): ParamSpec {
  return { name, type, description: `${name} parameter`, defaultValue };
}

function page(
  name: string,
  steps: StepSpec[] = [],
  overrides: Partial<ActionSpec> = {},
): ActionSpec {
  return { name, description: `${name} page`, inputs: [], outputs: [], steps, ...overrides };
}

function waitStep(overrides: Partial<WaitStep> = {}): WaitStep {
  return {
    kind: "waitFor",
    element: "field",
    timeoutSeconds: "[Wait Timeout]",
    args: { trackingid: "[Session]" },
    params: { wXPath: "[Field XPath]" },
    onTimeout: { type: "System Exception", detail: 'Field wait "timed out"' },
    ...overrides,
  };
}

function elementSteps(): ElementStep[] {
  return [
    waitStep(),
    {
      kind: "write",
      element: "field",
      value: "[Value]",
      args: { trackingid: "[Session]" },
      params: { wXPath: "[Field XPath]" },
    },
    {
      kind: "read",
      element: "field",
      action: "WebGetValue",
      into: "Observed",
      args: { trackingid: "[Session]" },
      params: { wXPath: "[Field XPath]" },
    },
    {
      kind: "act",
      element: "field",
      action: "WebSendKeys",
      args: { newtext: "[Value]", trackingid: "[Session]" },
      params: { wXPath: "[Field XPath]" },
    },
  ];
}

function exercise(steps: StepSpec[] = elementSteps()): ActionSpec {
  return page("Exercise", steps, {
    inputs: [
      param("Field XPath", "text"),
      param("Value", "text"),
      param("Wait Timeout", "number", 10),
      param("Session", "text", ""),
    ],
    outputs: [param("Observed", "text")],
  });
}

function objectSpec(actions: ActionSpec[] = [exercise()]): ObjectSpec {
  return {
    name: "Dynamic form - Tests",
    description: "Self-contained dynamic selector tests",
    runMode: "Foreground",
    application: {
      kind: "BrowserAttach",
      name: "Dynamic form",
      parameters: { WindowTitle: "Test" },
    },
    elements: [
      {
        key: "field",
        name: "Dynamic Field",
        type: "WebTextEdit",
        match: { wElementType: "INPUT" },
        dynamic: ["wXPath"],
      },
    ],
    // A valid cleanup signature for harness tests; this BrowserAttach fixture owns no lifecycle.
    actions: [...actions, page("Terminate")],
  };
}

function child(element: BpElement, name: string): BpElement {
  const found = firstChild(element, name);
  if (!found) throw new Error(`Missing <${name}> inside <${element.name}>`);
  return found;
}

function rootOf(spec: ObjectSpec): BpElement {
  // Check the XML actually emitted, including escaping, rather than only the builder tree.
  return parseBpXml(generateObject(spec, dynamicCatalog).xml).root;
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

function attributes(nodes: BpElement[], names: string[]): (string | undefined)[][] {
  return nodes.map((node) => names.map((name) => getAttr(node, name)));
}

function argumentsOf(element: BpElement): (string | undefined)[][] {
  return descendants(element, "argument").map((a) => [childText(a, "id"), childText(a, "value")]);
}

function elementReferences(root: BpElement): BpElement[] {
  const id = pageId(root, "Exercise");
  return [
    "Wait for Dynamic Field",
    "Write Dynamic Field",
    "Read Dynamic Field",
    "Send Keys Dynamic Field",
  ]
    .map((name) => stageNamed(root, name, id))
    .map((stage) =>
      child(
        stage.type === "WaitStart"
          ? child(child(stage.element, "choices"), "choice")
          : child(stage.element, "step"),
        "element",
      ),
    );
}

describe("dynamic Application Modeller attributes and stage parameters", () => {
  it("marks wXPath Dynamic and wElementType static, with both used for matching", () => {
    const root = rootOf(objectSpec());
    const field = listAppElements(root).find((e) => e.name === "Dynamic Field");
    if (!field) throw new Error("Missing application element");
    expect(field.attributes.filter((a) => a.inUse).map((a) => [a.name, a.value])).toEqual([
      ["wXPath", ""],
      ["wElementType", "INPUT"],
    ]);
    const matching = childElements(child(field.element, "attributes"), "attribute").filter(
      (a) => getAttr(a, "inuse") === "True",
    );
    expect(attributes(matching, ["name", "comparisontype"])).toEqual([
      ["wXPath", "dynamic"],
      ["wElementType", undefined],
    ]);
    expect(matching.map((a) => getAttr(child(a, "ProcessValue"), "datatype"))).toEqual([
      "text",
      "text",
    ]);
  });

  it("writes elementparameter children on wait, write, read, and navigate element references", () => {
    const root = rootOf(objectSpec());
    const field = listAppElements(root).find((e) => e.name === "Dynamic Field");
    if (!field) throw new Error("Missing application element");
    const references = elementReferences(root);
    expect(references).toHaveLength(4);
    for (const reference of references) {
      expect(getAttr(reference, "id")).toBe(field.id);
      expect(childElements(reference).map((node) => node.name)).toEqual(["elementparameter"]);
      const parameter = child(reference, "elementparameter");
      expect(
        childElements(parameter).map((node) => [node.name, childText(parameter, node.name)]),
      ).toEqual([
        ["name", "wXPath"],
        ["expression", "[Field XPath]"],
        ["datatype", "text"],
        ["comparisontype", "Equal"],
      ]);
      expect(getAttr(parameter, "name")).toBeUndefined();
    }
    expect(descendants(root, "elementparameter")).toHaveLength(4);
    const id = pageId(root, "Exercise");
    const write = child(stageNamed(root, "Write Dynamic Field", id).element, "step");
    const read = child(stageNamed(root, "Read Dynamic Field", id).element, "step");
    const act = child(stageNamed(root, "Send Keys Dynamic Field", id).element, "step");
    expect(getAttr(write, "expr")).toBe("[Value]");
    expect(getAttr(read, "stage")).toBe("Observed");
    expect(argumentsOf(write)).toEqual([["trackingid", "[Session]"]]);
    expect(argumentsOf(read)).toEqual([["trackingid", "[Session]"]]);
    expect(argumentsOf(act)).toEqual([
      ["newtext", "[Value]"],
      ["interval", ""],
      ["trackingid", "[Session]"],
    ]);
  });

  it("keeps each step's runtime XPath separate, including XML-sensitive expressions", () => {
    const expressions = [
      "[Field XPath]",
      `'write & <value>'`,
      `'read "value"'`,
      "\"//input[@name='last']\"",
    ];
    const steps = elementSteps().map((step, i) => ({
      ...step,
      params: { wXPath: expressions[i] ?? "" },
    }));
    const root = rootOf(objectSpec([exercise(steps)]));
    expect(
      elementReferences(root).map((e) => childText(child(e, "elementparameter"), "expression")),
    ).toEqual(expressions);
  });

  it.each(elementSteps())("requires runtime wXPath on every $kind step", (step) => {
    delete step.params;
    const spec = objectSpec([exercise([step])]);
    // Captured values describe observation; they must never silently supply a Dynamic value.
    const field = spec.elements[0];
    if (!field) throw new Error("Missing fixture field");
    field.captured = { wXPath: "//input[@name='captured']" };
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/steps\[0\].*\.params\.wXPath: missing runtime value/),
      ]),
    );
  });

  it.each(elementSteps())("rejects unknown and static attributes in $kind params", (step) => {
    step.params = { wXPath: "[Field XPath]", wUnknown: "[Value]", wElementType: '"INPUT"' };
    expect(issuesOf(() => generateObject(objectSpec([exercise([step])]), dynamicCatalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.params\.wUnknown: is not a Dynamic attribute/),
        expect.stringMatching(/\.params\.wElementType: is not a Dynamic attribute/),
      ]),
    );
  });

  it.each([
    {
      dynamic: ["wXPath"],
      match: { wXPath: "//input" },
      message: /also in match: choose static or dynamic/,
    },
    { dynamic: ["wXPath", "wXPath"], match: {}, message: /duplicate dynamic identifier/ },
    {
      dynamic: ["notAnIdentifier"],
      match: {},
      message: /unknown web identifier "notAnIdentifier"/,
    },
  ])("rejects invalid Dynamic declarations $dynamic", ({ dynamic, match, message }) => {
    const spec = objectSpec([exercise([])]);
    const field = spec.elements[0];
    if (!field) throw new Error("Missing fixture field");
    field.dynamic = dynamic;
    Object.assign(field.match, match);
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(message)]),
    );
  });

  it("rejects an empty runtime parameter instead of emitting an empty expression", () => {
    const spec = objectSpec([exercise([waitStep({ params: { wXPath: "" } })])]);
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/params\.wXPath/)]),
    );
  });
});

describe("dynamic Wait timeout, comparison, and arguments", () => {
  it("uses a numeric page input as the timeout and wires success and timeout separately", () => {
    const root = rootOf(objectSpec());
    const id = pageId(root, "Exercise");
    const wait = stageNamed(root, "Wait for Dynamic Field", id);
    const choice = child(child(wait.element, "choices"), "choice");
    const timeout = stageNamed(root, "Time Out", id);
    const failure = stageNamed(root, "System Exception", id);
    expect(childText(wait.element, "timeout")).toBe("[Wait Timeout]");
    expect(childText(choice, "name")).toBe("Condition met");
    expect(getAttr(choice, "expression")).toBe("True");
    expect(getAttr(choice, "reply")).toBeUndefined();
    expect(childText(choice, "comparetype")).toBe("Equal");
    expect(childText(child(choice, "condition"), "id")).toBe("WebCheckExists");
    expect(argumentsOf(choice)).toEqual([["trackingid", "[Session]"]]);
    expect(childText(choice, "ontrue")).toBe(stageNamed(root, "Write Dynamic Field", id).id);
    expect(wait.onSuccess).toBeUndefined();
    expect(timeout.type).toBe("WaitEnd");
    expect(childText(timeout.element, "groupid")).toBe(childText(wait.element, "groupid"));
    expect(timeout.onSuccess).toBe(failure.id);
    expect(failure.type).toBe("Exception");
    expect(getAttr(child(failure.element, "exception"), "detail")).toBe(
      '"Field wait ""timed out"""',
    );
    expect(failure.onSuccess).toBeUndefined();
    const timeoutData = stageNamed(root, "Wait Timeout", id);
    expect(childText(timeoutData.element, "datatype")).toBe("number");
    expect(childText(timeoutData.element, "initialvalue")).toBe("10");
    expect(
      attributes(descendants(stageNamed(root, "Start", id).element, "input"), ["name", "type"]),
    ).toContainEqual(["Wait Timeout", "number"]);
  });

  it.each([
    { condition: "WebCheckExists", expected: "False" },
    { condition: "WebCheckValue", expected: "[Value]" },
  ])("preserves $expected for $condition", (comparison) => {
    const root = rootOf(objectSpec([exercise([waitStep(comparison)])]));
    const wait = stageNamed(root, "Wait for Dynamic Field", pageId(root, "Exercise"));
    const choice = child(child(wait.element, "choices"), "choice");
    expect(getAttr(choice, "expression")).toBe(comparison.expected);
    expect(childText(child(choice, "condition"), "id")).toBe(comparison.condition);
    expect(argumentsOf(choice)).toEqual([["trackingid", "[Session]"]]);
  });

  it("keeps literal numeric timeouts and emits omitted condition arguments as empty", () => {
    const root = rootOf(
      objectSpec([exercise([waitStep({ timeoutSeconds: 2.5, args: undefined })])]),
    );
    const wait = stageNamed(root, "Wait for Dynamic Field", pageId(root, "Exercise"));
    expect(childText(wait.element, "timeout")).toBe("2.5");
    expect(argumentsOf(wait.element)).toEqual([["trackingid", ""]]);
  });

  it("requires an explicit expected expression for a text condition", () => {
    const spec = objectSpec([exercise([waitStep({ condition: "WebCheckValue" })])]);
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.condition: "WebCheckValue" yields text: provide the expected/),
      ]),
    );
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    "30",
    "[Missing]",
    "[Value]",
    "[Wait Timeout] + 1",
  ])("rejects invalid or untyped timeout %j", (timeoutSeconds) => {
    const spec = objectSpec([exercise([waitStep({ timeoutSeconds })])]);
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/timeoutSeconds/)]),
    );
  });

  it.each(elementSteps())("validates action or condition arguments on $kind", (step) => {
    step.args = { ...step.args, typoArgument: "True" };
    expect(issuesOf(() => generateObject(objectSpec([exercise([step])]), dynamicCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.args\.typoArgument: not an argument/)]),
    );
  });

  it("does not accept dynamic element parameters as condition arguments", () => {
    const step = waitStep({ params: undefined, args: { wXPath: "[Field XPath]" } });
    expect(issuesOf(() => generateObject(objectSpec([exercise([step])]), dynamicCatalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.args\.wXPath: not an argument of WebCheckExists/),
        expect.stringMatching(/\.params\.wXPath: missing runtime value/),
      ]),
    );
  });
});

describe("ensureAttached branch wiring", () => {
  it("reads connection state, attaches only on False, then rejoins the next step", () => {
    const attachPage = page(
      "Attach",
      [
        { kind: "ensureAttached", args: { WindowTitle: '"Test"', trackingid: '"session"' } },
        { kind: "calc", expression: "True", into: "Ready" },
      ],
      { inputs: [param("Attached", "flag")], outputs: [param("Ready", "flag")] },
    );
    const root = rootOf(objectSpec([attachPage]));
    const id = pageId(root, "Attach");
    const read = stageNamed(root, "Read Connection", id);
    const decision = stageNamed(root, "Already Attached?", id);
    const attach = stageNamed(root, "Attach Application", id);
    const joined = stageNamed(root, "Attached", id);
    expect(stageNamed(root, "Start", id).onSuccess).toBe(read.id);
    expect(read.onSuccess).toBe(decision.id);
    expect(getAttr(child(decision.element, "decision"), "expression")).toBe("[Attached 2]");
    expect(decision.onTrue).toBe(joined.id);
    expect(decision.onFalse).toBe(attach.id);
    expect(decision.onSuccess).toBeUndefined();
    expect(attach.onSuccess).toBe(joined.id);
    expect(joined.type).toBe("Anchor");
    expect(joined.onSuccess).toBe(stageNamed(root, "Set Ready", id).id);
    const application = listAppElements(root).find((e) => e.parentId === undefined);
    if (!application) throw new Error("Missing application root");
    for (const stage of [read, attach]) {
      expect(getAttr(child(child(stage.element, "step"), "element"), "id")).toBe(application.id);
    }
    const readStep = child(read.element, "step");
    expect(childText(child(readStep, "action"), "id")).toBe("IsConnected");
    expect(getAttr(readStep, "stage")).toBe("Attached 2");
    expect(childText(stageNamed(root, "Attached 2", id).element, "datatype")).toBe("flag");
    expect(childText(child(child(attach.element, "step"), "action"), "id")).toBe(
      "AttachApplication",
    );
    expect(argumentsOf(attach.element)).toEqual([
      ["WindowTitle", '"Test"'],
      ["trackingid", '"session"'],
    ]);
  });

  it("keeps repeated attachment checks independent without clobbering declared data", () => {
    const root = rootOf(
      objectSpec([
        page("Attach", [{ kind: "ensureAttached" }, { kind: "ensureAttached" }], {
          inputs: [param("Attached", "flag")],
        }),
      ]),
    );
    const id = pageId(root, "Attach");
    const reads = stagesOfPage(root, id).filter((s) => s.type === "Read");
    expect(reads.map((s) => getAttr(child(s.element, "step"), "stage"))).toEqual([
      "Attached 2",
      "Attached 3",
    ]);
    expect(stageNamed(root, "Attached", id).onSuccess).toBe(reads[1]?.id);
    const decisions = stagesOfPage(root, id).filter((s) => s.type === "Decision");
    expect(decisions.map((s) => getAttr(child(s.element, "decision"), "expression"))).toEqual([
      "[Attached 2]",
      "[Attached 3]",
    ]);
  });

  it("rejects attachment argument names absent from the catalog", () => {
    const spec = objectSpec([
      page("Attach", [{ kind: "ensureAttached", args: { typo: '"Test"' } }]),
    ]);
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.args\.typo: not an argument of AttachApplication/),
      ]),
    );
  });

  it("rejects an IsConnected operation that does not return flag", () => {
    const application = dynamicCatalog.elementType("Application", "BrowserAttach");
    if (!application) throw new Error("Missing fixture Application");
    const invalid = {
      ...application,
      readActions: application.readActions.map((op) =>
        op.id === "IsConnected" ? { ...op, returns: "text" } : op,
      ),
    };
    const invalidCatalog: Catalog = {
      ...dynamicCatalog,
      elementType: (id: string, applicationKind?: string) =>
        id === "Application" && applicationKind === "BrowserAttach"
          ? invalid
          : dynamicCatalog.elementType(id, applicationKind),
    };
    const spec = objectSpec([page("Attach", [{ kind: "ensureAttached" }])]);
    expect(issuesOf(() => generateObject(spec, invalidCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/IsConnected.*flag/)]),
    );
  });
});

function worker(): ActionSpec {
  return page("Worker", [{ kind: "calc", expression: "[Value]", into: "Result" }], {
    published: false,
    inputs: [param("Value", "text"), param("Wait Timeout", "number", 7)],
    outputs: [param("Result", "text")],
  });
}

function callWorker(overrides: Partial<CallStep> = {}): CallStep {
  return {
    kind: "callPage",
    page: "Worker",
    inputs: { Value: "[Payload]", "Wait Timeout": "[Local Timeout]" },
    outputs: { Result: "Observed" },
    ...overrides,
  };
}

function caller(steps: StepSpec[] = [callWorker()]): ActionSpec {
  return page("Caller", steps, {
    inputs: [param("Payload", "text"), param("Local Timeout", "number", 20)],
    outputs: [param("Observed", "text")],
  });
}

describe("callPage references, signatures, and visibility", () => {
  it("references the callee GUID and binds its signature in the caller's SubSheet stage", () => {
    const root = rootOf(objectSpec([caller(), worker()]));
    const from = pageId(root, "Caller");
    const to = pageId(root, "Worker");
    const call = stageNamed(root, "Worker", from);
    expect(call.type).toBe("SubSheet");
    expect(call.pageId).toBe(from);
    expect(childText(call.element, "processid")).toBe(to);
    expect(to).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    expect(firstChild(call.element, "resource")).toBeUndefined();
    expect(stageNamed(root, "Start", from).onSuccess).toBe(call.id);
    expect(call.onSuccess).toBe(stageNamed(root, "End", from).id);
    expect(
      attributes(descendants(call.element, "input"), ["name", "friendlyname", "type", "expr"]),
    ).toEqual([
      ["Value", "Value", "text", "[Payload]"],
      ["Wait Timeout", "Wait Timeout", "number", "[Local Timeout]"],
    ]);
    expect(
      attributes(descendants(call.element, "output"), ["name", "friendlyname", "type", "stage"]),
    ).toEqual([["Result", "Result", "text", "Observed"]]);
    expect(
      attributes(descendants(stageNamed(root, "Start", to).element, "input"), [
        "name",
        "type",
        "stage",
      ]),
    ).toEqual([
      ["Value", "text", "Value"],
      ["Wait Timeout", "number", "Wait Timeout"],
    ]);
    expect(
      attributes(descendants(stageNamed(root, "End", to).element, "output"), [
        "name",
        "type",
        "stage",
      ]),
    ).toEqual([["Result", "text", "Result"]]);
    const privatePage = childElements(root, "subsheet").find(
      (s) => getAttr(s, "subsheetid") === to,
    );
    expect(privatePage && getAttr(privatePage, "published")).toBe("False");
  });

  it("allows repeated calls and a shared callee without duplicating page or stage GUIDs", () => {
    const root = rootOf(
      objectSpec([
        caller([callWorker(), callWorker()]),
        worker(),
        page("Other", [callWorker({ inputs: { Value: '"other"' }, outputs: {} })]),
      ]),
    );
    const calls = listStages(root).filter((s) => s.type === "SubSheet");
    expect(calls).toHaveLength(3);
    expect(calls.map((s) => childText(s.element, "processid"))).toEqual(
      Array(3).fill(pageId(root, "Worker")),
    );
    const declarations = [
      ...listStages(root).map((s) => s.id),
      ...childElements(root, "subsheet").map((s) => getAttr(s, "subsheetid")),
    ];
    expect(new Set(declarations).size).toBe(declarations.length);
  });

  const invalidCalls: { override: Partial<CallStep>; message: RegExp }[] = [
    { override: { page: "Missing" }, message: /\.page: unknown page "Missing"/ },
    { override: { inputs: {} }, message: /\.inputs: missing input "Value" of Worker/ },
    {
      override: { inputs: { Value: "[Payload]", Unknown: "True" } },
      message: /\.inputs\.Unknown: not an input/,
    },
    {
      override: { outputs: { Missing: "Observed" } },
      message: /\.outputs\.Missing: not an output/,
    },
  ];
  it.each(invalidCalls)("rejects invalid page calls: $message", ({ override, message }) => {
    const spec = objectSpec([caller([callWorker(override)]), worker()]);
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(message)]),
    );
  });

  it("rejects an output binding whose existing caller data item has a different type", () => {
    const from = caller();
    from.outputs = [param("Observed", "flag")];
    expect(issuesOf(() => generateObject(objectSpec([from, worker()]), dynamicCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/"Observed" is flag but Worker gives text/)]),
    );
  });

  it.each([
    [page("A", [{ kind: "callPage", page: "A" }])],
    [page("A", [{ kind: "callPage", page: "B" }]), page("B", [{ kind: "callPage", page: "A" }])],
  ])("rejects recursive call graphs", (...actions) => {
    expect(issuesOf(() => generateObject(objectSpec(actions), dynamicCatalog))).toEqual(
      expect.arrayContaining([expect.stringMatching(/recursive page call: A -> (B -> )?A/)]),
    );
  });

  it("rejects private pages as harness actions even with a valid input signature", () => {
    const spec = objectSpec([worker()]);
    const harness: TestHarnessSpec = {
      object: spec.name,
      calls: [{ action: "Worker", inputs: { Value: '"test"' } }],
      cleanupAction: "Terminate",
    };
    expect(issuesOf(() => generateTestHarness(harness, spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/calls\[0\].*\.action: "Worker" is a private helper page/),
      ]),
    );
  });

  it("rejects a private no-input page as the harness cleanup action", () => {
    const spec = objectSpec([page("Public"), page("Private cleanup", [], { published: false })]);
    const harness: TestHarnessSpec = {
      object: spec.name,
      calls: [{ action: "Public" }],
      cleanupAction: "Private cleanup",
    };
    expect(issuesOf(() => generateTestHarness(harness, spec, dynamicCatalog))).toEqual([
      'cleanupAction: "Private cleanup" is a private helper page',
    ]);
  });
});

function defaultsPage(): ActionSpec {
  return page("Defaults", [], {
    inputs: [
      param("Text", "text", 'He said "go" & <ok>'),
      param("Count", "number", 0),
      param("Enabled", "flag", false),
      param("Empty", "text", ""),
      param("Positive", "flag", true),
    ],
  });
}

function defaultsCall(kind: "harness" | "subpage", inputs?: Record<string, string>): BpElement {
  const spec = objectSpec([
    defaultsPage(),
    page("Caller", [{ kind: "callPage", page: "Defaults", inputs }]),
  ]);
  if (kind === "subpage") {
    const root = rootOf(spec);
    return stageNamed(root, "Defaults", pageId(root, "Caller")).element;
  }
  const harness: TestHarnessSpec = {
    object: spec.name,
    calls: [{ action: "Defaults", inputs }],
    cleanupAction: "Terminate",
  };
  return stageNamed(
    parseBpXml(generateTestHarness(harness, spec, dynamicCatalog).xml).root,
    "Defaults",
  ).element;
}

describe("defaultValue at harness and subpage call boundaries", () => {
  it.each(["harness", "subpage"] as const)(
    "supplies typed defaults from a %s, including falsy literals",
    (kind) => {
      expect(
        attributes(descendants(defaultsCall(kind), "input"), ["name", "type", "expr"]),
      ).toEqual([
        ["Text", "text", '"He said ""go"" & <ok>"'],
        ["Count", "number", "0"],
        ["Enabled", "flag", "False"],
        ["Empty", "text", '""'],
        ["Positive", "flag", "True"],
      ]);
    },
  );

  it.each(["harness", "subpage"] as const)(
    "lets explicit %s expressions override defaults",
    (kind) => {
      const call = defaultsCall(kind, { Count: "42", Enabled: "True", Text: '"override"' });
      expect(attributes(descendants(call, "input"), ["name", "expr"])).toEqual([
        ["Text", '"override"'],
        ["Count", "42"],
        ["Enabled", "True"],
        ["Empty", '""'],
        ["Positive", "True"],
      ]);
    },
  );

  it("initializes callee data items with literal values rather than expression quoting", () => {
    const root = rootOf(objectSpec([defaultsPage()]));
    const data = stagesOfPage(root, pageId(root, "Defaults")).filter((s) => s.type === "Data");
    expect(
      data.map((s) => [
        s.name,
        childText(s.element, "datatype"),
        childText(s.element, "initialvalue"),
      ]),
    ).toEqual([
      ["Text", "text", 'He said "go" & <ok>'],
      ["Count", "number", "0"],
      ["Enabled", "flag", "False"],
      ["Empty", "text", ""],
      ["Positive", "flag", "True"],
    ]);
  });

  it("still rejects a missing required harness input with no defaultValue", () => {
    const spec = objectSpec([page("Required", [], { inputs: [param("Value", "text")] })]);
    const harness: TestHarnessSpec = {
      object: spec.name,
      calls: [{ action: "Required" }],
      cleanupAction: "Terminate",
    };
    expect(issuesOf(() => generateTestHarness(harness, spec, dynamicCatalog))).toEqual([
      'calls[0] "Required".inputs: missing input "Value" of Required',
    ]);
  });

  it.each([
    param("Wrong", "number", "10"),
    param("Wrong", "flag", "False"),
    param("Wrong", "text", 10),
  ])("rejects a defaultValue that disagrees with its declared $type type", (input) => {
    const spec = objectSpec([page("Defaults", [], { inputs: [input] })]);
    expect(issuesOf(() => generateObject(spec, dynamicCatalog))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.inputs\[0\]\.defaultValue: must be a .* literal/),
      ]),
    );
  });
});

describe("dynamic generation determinism", () => {
  it("produces identical object and harness XML without mutating caller-owned specs", () => {
    const spec = objectSpec([
      page("Attach", [{ kind: "ensureAttached" }], { published: false }),
      exercise([{ kind: "callPage", page: "Attach" }, ...elementSteps()]),
    ]);
    const harness: TestHarnessSpec = {
      object: spec.name,
      calls: [
        {
          action: "Exercise",
          inputs: { "Field XPath": "\"//input[@name='first']\"", Value: '"A&B"' },
          expect: { Observed: "A&B" },
        },
      ],
      cleanupAction: "Terminate",
    };
    const beforeSpec = structuredClone(spec);
    const beforeHarness = structuredClone(harness);
    const objectXml = generateObject(spec, dynamicCatalog).xml;
    const harnessXml = generateTestHarness(harness, spec, dynamicCatalog).xml;
    expect(generateObject(spec, dynamicCatalog).xml).toBe(objectXml);
    expect(generateTestHarness(harness, spec, dynamicCatalog).xml).toBe(harnessXml);
    expect(serializeBpXml(parseBpXml(objectXml))).toBe(objectXml);
    expect(serializeBpXml(parseBpXml(harnessXml))).toBe(harnessXml);
    expect(spec).toEqual(beforeSpec);
    expect(harness).toEqual(beforeHarness);
  });

  it("orders dynamic parameters by catalog order, independent of input-map and declaration order", () => {
    const first = objectSpec();
    const second = objectSpec();
    for (const [i, spec] of [first, second].entries()) {
      const field = spec.elements[0];
      const action = spec.actions[0];
      if (!field || !action) throw new Error("Missing fixture field or action");
      field.dynamic = i === 0 ? ["wXPath", "wX"] : ["wX", "wXPath"];
      action.inputs.push(param("Field X", "number", 0));
      action.steps = elementSteps().map((step) => ({
        ...step,
        params:
          i === 0
            ? { wXPath: "[Field XPath]", wX: "[Field X]" }
            : { wX: "[Field X]", wXPath: "[Field XPath]" },
      }));
    }
    expect(generateObject(first, dynamicCatalog).xml).toBe(
      generateObject(second, dynamicCatalog).xml,
    );
    for (const reference of elementReferences(rootOf(first))) {
      expect(
        childElements(reference, "elementparameter").map((p) => [
          childText(p, "name"),
          childText(p, "datatype"),
        ]),
      ).toEqual([
        ["wX", "number"],
        ["wXPath", "text"],
      ]);
    }
  });
});
