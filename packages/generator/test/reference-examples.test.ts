import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, type Catalog } from "@bpdev/catalog";
import { childText, getAttr, listStages, parseBpXml, type BpElement } from "@bpdev/model";
import { describe, expect, it } from "vitest";
import { generateObject, parseObjectSpec } from "../src/index.js";
import { catalog, descendants, EXAMPLES, pageId, stageNamed } from "./helpers.js";

const examples = [
  {
    file: "rpa-challenge.basic-actions.object.json",
    mode: "BrowserLaunch",
    read: "WebIsConnected",
  },
  { file: "rpa-challenge.form.object.json", mode: "BrowserAttach", read: "IsConnected" },
] as const;
const options = { robotProfileDir: "C:\\Robot Profiles\\Test browser" };
const attachArguments = [
  ["WindowTitlesCollection", "collection"],
  ["WindowTitle", "text"],
  ["ProcessName", "text"],
  ["ProcessID", "number"],
  ["Username", "text"],
  ["ChildIndex", "number"],
];

function example(file: string) {
  // Read the exact checked-in input; never substitute a simplified object or synthetic AMI.
  return parseObjectSpec(JSON.parse(readFileSync(join(EXAMPLES, file), "utf8")) as unknown);
}

function argumentsOf(element: BpElement) {
  return descendants(element, "argument").map((a) => [childText(a, "id"), childText(a, "value")]);
}

function checkExample(file: string, selectedCatalog: Catalog) {
  const spec = example(file);
  const before = structuredClone(spec);
  const result = generateObject(spec, selectedCatalog, options);
  expect(spec).toEqual(before);
  expect(generateObject(spec, selectedCatalog, options).xml).toBe(result.xml);
  const root = parseBpXml(result.xml).root;
  const attach = stageNamed(root, "Attach Application", pageId(root, "Attach"));
  expect(argumentsOf(attach.element)).toEqual([
    ["WindowTitlesCollection", ""],
    ["WindowTitle", '"Rpa Challenge*"'],
    ["ProcessName", '"chrome"'],
    ["ProcessID", ""],
    ["Username", ""],
    ["ChildIndex", ""],
  ]);
  const read = stageNamed(root, "Read Connection", pageId(root, "Attach"));
  const [operation] = descendants(read.element, "action");
  expect(operation && childText(operation, "id")).toBe(
    spec.application.kind === "BrowserLaunch" ? "WebIsConnected" : "IsConnected",
  );
  expect(argumentsOf(read.element)).toEqual(
    spec.application.kind === "BrowserLaunch" ? [["trackingid", ""]] : [],
  );
  return root;
}

describe("exact Basic Actions and Form public examples / AMI 7.5.1 contracts", () => {
  it.each(examples)(
    "generates $file against the hand-written real signatures",
    ({ file, mode, read }) => {
      const application = catalog.elementType("Application", mode);
      const attach = application?.actions.find((a) => a.id === "AttachApplication");
      expect(attach?.arguments.map((a) => [a.id, a.dataType])).toEqual(attachArguments);
      expect(attach?.outputs).toEqual([{ id: "trackingid", dataType: "text" }]);
      expect(application?.readActions.find((a) => a.id === read)).toEqual({
        id: read,
        returns: "flag",
        outputs: [],
        arguments: mode === "BrowserLaunch" ? [{ id: "trackingid", dataType: "text" }] : [],
      });
      checkExample(file, catalog);
    },
  );

  it("keeps the exact Basic Actions profile path quoted when it contains spaces", () => {
    const root = checkExample(examples[0].file, catalog);
    const commandLine = descendants(root, "parameter").find(
      (p) => childText(p, "name") === "CommandLineParams",
    );
    expect(commandLine && childText(commandLine, "value")).toContain(
      '--user-data-dir="C:\\Robot Profiles\\Test browser"',
    );
  });

  it("keeps the same dynamic XPath for Wait, Write, Wait Value and Read in Form", () => {
    const root = checkExample(examples[1].file, catalog);
    const id = pageId(root, "Set Field");
    for (const name of ["Wait Field", "Write Value", "Wait Value", "Read Value"]) {
      const stage = stageNamed(root, name, id);
      expect(
        descendants(stage.element, "elementparameter").map((p) => [
          childText(p, "name"),
          childText(p, "expression"),
        ]),
      ).toEqual([["wXPath", "[Field XPath]"]]);
    }
    expect(
      getAttr(
        descendants(stageNamed(root, "Wait Value", id).element, "choice")[0] as BpElement,
        "expression",
      ),
    ).toBe("[Value]");
    expect(
      listStages(root)
        .filter((s) => s.type === "Data")
        .some((s) => childText(s.element, "datatype") === "collection"),
    ).toBe(false);
  });
});

const realDirectory = join(import.meta.dirname, "../../../.bpdev/catalog");
const hasLocalCatalog =
  existsSync(join(realDirectory, "catalog.json")) &&
  existsSync(join(realDirectory, "apptypes.json"));
describe("optional local AMI cross-check (read only, no BP execution)", () => {
  it.skipIf(!hasLocalCatalog)("matches real signatures and generates both exact examples", () => {
    const real = loadCatalog(realDirectory);
    for (const { file, mode, read } of examples) {
      checkExample(file, real);
      const fixtureRoot = catalog.elementType("Application", mode);
      const nativeRoot = real.elementType("Application", mode);
      for (const id of mode === "BrowserLaunch"
        ? ["Launch", "AttachApplication", "WebCloseApplication"]
        : ["AttachApplication"]) {
        expect(fixtureRoot?.actions.find((a) => a.id === id)).toEqual(
          nativeRoot?.actions.find((a) => a.id === id),
        );
      }
      expect(fixtureRoot?.readActions.find((a) => a.id === read)).toEqual(
        nativeRoot?.readActions.find((a) => a.id === read),
      );
    }
    for (const type of ["WebButton", "WebTextEdit"]) {
      const fixture = catalog.elementType(type);
      const native = real.elementType(type);
      expect(fixture?.actions.find((a) => a.id === "WebClick")).toEqual(
        native?.actions.find((a) => a.id === "WebClick"),
      );
      expect(fixture?.readActions.find((a) => a.id === "WebGetValue")).toEqual(
        native?.readActions.find((a) => a.id === "WebGetValue"),
      );
      expect(fixture?.writeAction).toEqual(native?.writeAction);
      for (const id of ["WebCheckExists", "WebCheckValue"]) {
        expect(fixture?.conditions.find((a) => a.id === id)).toEqual(
          native?.conditions.find((a) => a.id === id),
        );
      }
    }
  });
});
