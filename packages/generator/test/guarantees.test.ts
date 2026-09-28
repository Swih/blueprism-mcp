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
  DuplicateIdError,
  generateObject,
  generateTestHarness,
  SpecValidationError,
} from "../src/index.js";
import { IdRegistry } from "../src/ids.js";
import { DATA_X, MAIN_X } from "../src/layout.js";
import {
  catalog,
  descendants,
  display,
  exampleHarness,
  exampleObject,
  OPTIONS,
  pageId,
  stageNamed,
  stagesOfPage,
} from "./helpers.js";

const object = generateObject(exampleObject(), catalog, OPTIONS);
const harness = generateTestHarness(exampleHarness(), exampleObject(), catalog);
const root = object.document.root;

function issuesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof SpecValidationError)
      return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  throw new Error("expected a SpecValidationError");
}

describe("G1: typed application root", () => {
  it("types the appdef root element Application / unknown, with diagnose", () => {
    const app = listAppElements(root).find((e) => e.parentId === undefined);
    expect(app?.name).toBe("RPA Challenge");
    const fields = ["type", "basetype", "datatype", "diagnose"].map(
      (f) => app && childText(app.element, f),
    );
    expect(fields).toEqual(["Application", "Application", "unknown", "False"]);
  });
});

describe("G2: complete apptypeinfo", () => {
  it("lists every BrowserLaunch parameter of the catalogue, prelaunchbrowser included", () => {
    const info = descendants(root, "apptypeinfo")[0];
    expect(info && childText(info, "id")).toBe("BrowserLaunch");
    const params = info ? descendants(info, "parameter") : [];
    const pairs = params.map((p) => [childText(p, "name"), childText(p, "value")]);
    expect(pairs).toEqual([
      ["Path", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
      [
        "CommandLineParams",
        "https://rpachallenge.com/ --user-data-dir=C:\\bpdev\\robot-chrome-profile " +
          "--no-first-run --no-default-browser-check",
      ],
      ["prelaunchbrowser", "False"],
      ["ProcessMode", "Internal"],
      ["ExternalProcessTimeout", "0"],
    ]);
    expect(pairs.map(([name]) => name)).toEqual(
      catalog.appType("BrowserLaunch")?.parameters.map((p) => p.name),
    );
  });

  it("requires options.robotProfileDir when the spec uses {robotProfileDir}", () => {
    expect(issuesOf(() => generateObject(exampleObject(), catalog))).toEqual([
      "application.extraArgs[0]: uses {robotProfileDir}: pass options.robotProfileDir to generate this object",
    ]);
  });
});

describe("G3: every identifier, inuse only for match", () => {
  it("emits all catalogue identifiers in order, flags only the match ones", () => {
    const elements = listAppElements(root).filter((e) => e.parentId !== undefined);
    expect(elements.map((e) => e.name)).toEqual(["Home - Start Button", "Form - First Name Field"]);
    for (const element of elements) {
      expect(element.attributes.map((a) => `${a.name}:${a.datatype ?? ""}`)).toEqual(
        catalog.webIdentifiers.map((i) => `${i.id}:${i.dataType}`),
      );
    }
    const field = elements[1];
    expect(field?.attributes.filter((a) => a.inUse).map((a) => [a.name, a.value])).toEqual([
      ["wCssSelector", "input[ng-reflect-name='labelFirstName']"],
      ["wElementType", "INPUT"],
    ]);
    // Captured values are kept but not used for matching; the others get empty defaults.
    const byName = new Map(field?.attributes.map((a) => [a.name, a]));
    expect(byName.get("wPageAddress")).toMatchObject({
      inUse: false,
      value: "https://rpachallenge.com/",
    });
    expect(byName.get("wX")?.value).toBe("0");
    expect(byName.get("wIsEditable")?.value).toBe("False");
  });
});

describe("G4: every catalogue argument on every application step", () => {
  it("writes all arguments of each action and condition, in catalogue order", () => {
    const types = new Map(listAppElements(root).map((e) => [e.id, e.type ?? ""]));
    const operations = [
      ...descendants(root, "step").map((s) => ({ owner: s, spec: firstChild(s, "action") })),
      ...descendants(root, "choice").map((c) => ({ owner: c, spec: firstChild(c, "condition") })),
    ];
    expect(operations).toHaveLength(8); // 5 Navigate/Read/Write steps + 3 wait choices
    for (const { owner, spec } of operations) {
      const elementId = getAttr(firstChild(owner, "element") as BpElement, "id") ?? "";
      const type = catalog.elementType(types.get(elementId) ?? "");
      const id = spec && childText(spec, "id");
      const declared = [
        ...(type?.actions ?? []),
        ...(type?.readActions ?? []),
        ...(type?.writeAction ? [type.writeAction] : []),
        ...(type?.conditions ?? []),
      ].find((o) => o.id === id);
      const written = spec ? descendants(spec, "argument").map((a) => childText(a, "id")) : [];
      expect(declared, `${String(id)} on ${String(type?.id)}`).toBeDefined();
      expect(written).toEqual(declared?.arguments.map((a) => a.id));
    }
  });

  it("fills given arguments and leaves the others empty", () => {
    const spec = exampleObject();
    spec.actions[0]?.steps.push({
      kind: "act",
      element: "firstNameField",
      action: "WebSendKeys",
      args: { newtext: '"{TAB}"' },
    });
    const doc = generateObject(spec, catalog, OPTIONS).document.root;
    const step = stageNamed(doc, "Send Keys Form - First Name Field").element;
    const args = descendants(step, "argument").map((a) => [
      childText(a, "id"),
      childText(a, "value"),
    ]);
    expect(args).toEqual([
      ["newtext", '"{TAB}"'],
      ["interval", ""],
      ["trackingid", ""],
    ]);
  });
});

describe("G5: actions and conditions must be allowed for the element type", () => {
  it("rejects an action the element type does not have, naming step, element type and action", () => {
    const spec = exampleObject();
    spec.actions[3]?.steps.push({ kind: "act", element: "startButton", action: "WebSubmit" });
    const [issue] = issuesOf(() => generateObject(spec, catalog, OPTIONS));
    expect(issue).toMatch(
      /^actions\[3\] "Terminate"\.steps\[1\] \(act\)\.action: "WebSubmit" is not an allowed action of WebButton/,
    );
  });

  it("rejects a Wait condition the element type does not have", () => {
    const spec = exampleObject();
    const wait = spec.actions[0]?.steps[1];
    if (wait?.kind === "waitFor") wait.condition = "WebCheckIsChecked";
    expect(issuesOf(() => generateObject(spec, catalog, OPTIONS))[0]).toMatch(
      /steps\[1\] \(waitFor\)\.condition: "WebCheckIsChecked" is not a Wait condition of WebButton/,
    );
  });
});

describe("G6: deterministic GUIDs, never duplicated", () => {
  it("derives the same GUID from the same path, and throws on a duplicate", () => {
    const a = new IdRegistry();
    const b = new IdRegistry();
    expect(a.id("Obj", "Page", "Write", "Write X")).toBe(b.id("Obj", "Page", "Write", "Write X"));
    expect(a.id("Obj", "Page", "Write", "Write Y")).not.toBe(
      b.id("Obj", "Page", "Read", "Write Y"),
    );
    expect(() => a.id("Obj", "Page", "Write", "Write X")).toThrow(DuplicateIdError);
    // "/" inside a name cannot forge another path.
    expect(() => {
      a.id("Obj/Page", "Write");
      a.id("Obj", "Page/Write");
    }).not.toThrow();
  });

  it("gives every stage, page and element of a document its own GUID", () => {
    const spec = exampleObject();
    const write = spec.actions[1]?.steps[1];
    if (write) spec.actions[1]?.steps.push(write); // same step twice: "Write X", "Write X 2"
    const doc = generateObject(spec, catalog, OPTIONS).document.root;
    const ids = [
      getAttr(doc, "preferredid"),
      ...listStages(doc).map((s) => s.id),
      ...childElements(doc, "subsheet").map((s) => getAttr(s, "subsheetid")),
      ...listAppElements(doc).map((e) => e.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      listStages(doc)
        .filter((s) => s.type === "Write")
        .map((s) => s.name),
    ).toEqual(["Write Form - First Name Field", "Write Form - First Name Field 2"]);
  });
});

describe("G7: main page with ProcessInfo, Initialise and Clean Up", () => {
  it("gives the object a main (Initialise) page with code options and a Clean Up page", () => {
    const main = stagesOfPage(root, undefined);
    expect(main.map((s) => s.type)).toEqual(["ProcessInfo", "Start", "End"]);
    const info = main[0]?.element;
    const options = info ? childElements(info).map((c) => c.name) : [];
    expect(options).toEqual(
      expect.arrayContaining(["references", "imports", "language", "globalcode", "code"]),
    );
    const cleanUp = childElements(root, "subsheet").find(
      (s) => childText(s, "name") === "Clean Up",
    );
    expect(cleanUp && getAttr(cleanUp, "type")).toBe("CleanUp");
    expect(stagesOfPage(root, pageId(root, "Clean Up")).map((s) => s.type)).toEqual([
      "SubSheetInfo",
      "Start",
      "End",
    ]);
  });

  it("gives the test process a main page ProcessInfo without code options", () => {
    const info = stagesOfPage(harness.document.root, undefined).find(
      (s) => s.type === "ProcessInfo",
    );
    expect(info && childElements(info.element).map((c) => c.name)).toEqual(["display"]);
  });
});

describe("G8: friendlyname on Action stage parameters", () => {
  it("names every input and output of the harness Action stages", () => {
    const actions = listStages(harness.document.root).filter((s) => s.type === "Action");
    const params = actions.flatMap((s) => [
      ...descendants(s.element, "input"),
      ...descendants(s.element, "output"),
    ]);
    expect(params).toHaveLength(3);
    for (const p of params) expect(getAttr(p, "friendlyname")).toBe(getAttr(p, "name"));
  });
});

describe("G9: no loginhibit", () => {
  it("never inhibits logging", () => {
    expect(object.xml).not.toContain("loginhibit");
    expect(harness.xml).not.toContain("loginhibit");
  });
});

describe("G10: waitFor = WaitStart, choice, WaitEnd, Exception", () => {
  it("continues on the choice and raises the given exception after the timeout", () => {
    const page = pageId(root, "Launch");
    const wait = stageNamed(root, "Wait for Home - Start Button", page);
    expect(childText(wait.element, "timeout")).toBe("30");
    const choice = descendants(wait.element, "choice")[0] as BpElement;
    expect(childText(choice, "name")).toBe("Condition met");
    expect(getAttr(choice, "expression")).toBe("True");
    expect(childText(firstChild(choice, "condition") as BpElement, "id")).toBe("WebCheckExists");
    expect(childText(choice, "ontrue")).toBe(stageNamed(root, "End", page).id);

    const groupId = childText(wait.element, "groupid");
    const waitEnd = stageNamed(root, "Time Out", page);
    expect(waitEnd.type).toBe("WaitEnd");
    expect(childText(waitEnd.element, "groupid")).toBe(groupId);
    // Native 7.5.1 resets the condition position to zero if its group end loads later.
    const serializedStages = childElements(root, "stage");
    expect(serializedStages.indexOf(waitEnd.element)).toBeLessThan(
      serializedStages.indexOf(wait.element),
    );
    const exception = stageNamed(root, "System Exception", page);
    expect(waitEnd.onSuccess).toBe(exception.id);
    expect(exception.type).toBe("Exception");
    const raised = firstChild(exception.element, "exception");
    expect(raised && [getAttr(raised, "type"), getAttr(raised, "detail")]).toEqual([
      "System Exception",
      '"RPA Challenge home page did not load (START button not found)"',
    ]);
  });
});

describe("G11: readable layout", () => {
  it("puts the main flow in one column, branches to its right and data items together", () => {
    for (const page of ["Launch", "Set Field First Name", "Get Start Text"]) {
      const stages = stagesOfPage(root, pageId(root, page));
      const positions = stages.map((s) => `${display(s).x},${display(s).y}`);
      expect(new Set(positions).size, `overlap on ${page}`).toBe(positions.length);

      const flow = stages.filter((s) =>
        ["Start", "End", "Navigate", "Read", "Write"].includes(s.type),
      );
      expect(flow.every((s) => display(s).x === MAIN_X)).toBe(true);
      const ys = flow.map((s) => display(s).y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));

      for (const wait of stages.filter((s) => s.type === "WaitStart")) {
        expect(display(wait).x).toBeLessThan(MAIN_X);
        const choice = descendants(wait.element, "choice")[0] as BpElement;
        expect(display(wait).x + Number(childText(choice, "distance"))).toBe(MAIN_X);
      }

      const branches = stages.filter((s) => s.type === "WaitEnd" || s.type === "Exception");
      expect(branches.every((s) => display(s).x > MAIN_X && display(s).x < DATA_X)).toBe(true);
      const data = stages.filter((s) => s.type === "Data");
      expect(data.every((s) => display(s).x === DATA_X)).toBe(true);
    }
  });
});

describe("determinism", () => {
  it("generates byte-identical XML twice", () => {
    expect(generateObject(exampleObject(), catalog, OPTIONS).xml).toBe(object.xml);
    expect(generateTestHarness(exampleHarness(), exampleObject(), catalog).xml).toBe(harness.xml);
  });

  it("produces XML that survives a parse / serialize round trip unchanged", () => {
    expect(serializeBpXml(parseBpXml(object.xml))).toBe(object.xml);
    expect(serializeBpXml(parseBpXml(harness.xml))).toBe(harness.xml);
  });
});
