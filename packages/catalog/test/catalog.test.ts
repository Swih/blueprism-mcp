import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CatalogFileError,
  CatalogSchemaError,
  createCatalog,
  DEFAULT_CATALOG_DIR,
  loadCatalog,
} from "../src/index.js";
import type { RawCatalogFile } from "../src/schema.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const REAL_DIR = join(import.meta.dirname, "../../..", DEFAULT_CATALOG_DIR);

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;

function tempDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bpdev-catalog-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("loadCatalog (fixture subset)", () => {
  const catalog = loadCatalog(FIXTURES);

  it("looks element types up by id", () => {
    expect(catalog.elementTypes.map((t) => t.id)).toEqual([
      "Application",
      "WebElement",
      "WebButton",
      "WebTextEdit",
      "WebListItem",
    ]);
    expect(catalog.elementType("WebButton")?.appType).toBe("Web");
    expect(catalog.elementType("Nope")).toBeUndefined();
  });

  it("exposes actions with every argument and output, in catalogue order", () => {
    const launch = catalog.elementType("Application")?.actions.find((a) => a.id === "Launch");
    expect(launch?.arguments).toEqual([
      { id: "Path", dataType: "text" },
      { id: "CommandLineParams", dataType: "text" },
      { id: "prelaunchbrowser", dataType: "flag" },
      { id: "ProcessMode", dataType: "text" },
    ]);
    expect(launch?.outputs).toEqual([{ id: "trackingid", dataType: "text" }]);
  });

  it("exposes read actions with their return type, the write action and conditions", () => {
    const edit = catalog.elementType("WebTextEdit");
    expect(edit?.readActions.find((r) => r.id === "WebGetValue")?.returns).toBe("text");
    expect(edit?.writeAction?.id).toBe("WebWrite");
    expect(edit?.conditions.find((c) => c.id === "WebCheckExists")).toEqual({
      id: "WebCheckExists",
      dataType: "flag",
      defaultValue: "True",
      arguments: [{ id: "trackingid", dataType: "text" }],
    });
    expect(catalog.elementType("WebListItem")?.writeAction).toBeUndefined();
  });

  it("keeps the web identifiers in Blue Prism's order with their data types", () => {
    expect(catalog.webIdentifiers).toHaveLength(38);
    expect(catalog.webIdentifiers.slice(0, 3).map((i) => `${i.id}:${i.dataType}`)).toEqual([
      "wX:number",
      "wY:number",
      "wWidth:number",
    ]);
    expect(catalog.webIdentifiers.find((i) => i.id === "wIsEditable")?.dataType).toBe("flag");
  });

  it("lists the parameters of selectable application types (leaves only)", () => {
    const launch = catalog.appType("BrowserLaunch");
    expect(launch?.parameters.map((p) => p.name)).toEqual([
      "Path",
      "CommandLineParams",
      "prelaunchbrowser",
      "ProcessMode",
      "ExternalProcessTimeout",
    ]);
    expect(launch?.parameters.map((p) => p.defaultValue)).toEqual([
      "",
      undefined,
      "False",
      "Internal",
      "0",
    ]);
    expect(catalog.appType("Browser")).toBeUndefined();
    expect(catalog.appTypes.map((t) => t.id)).toEqual(["BrowserLaunch", "BrowserAttach"]);
  });
});

describe("Application root by mode", () => {
  const catalog = loadCatalog(FIXTURES);

  it("selects the actual Attach root without changing legacy or web lookups", () => {
    const attach = catalog.elementType("Application", "BrowserAttach");
    expect(attach).toBe(catalog.browserAttachApplication);
    expect(attach?.readActions).toEqual([
      { id: "IsConnected", returns: "flag", arguments: [], outputs: [] },
    ]);
    expect(attach?.actions[0]?.id).toBe("AttachApplication");
    expect(attach?.actions[0]?.arguments.map((a) => a.id)).toEqual([
      "WindowTitlesCollection",
      "WindowTitle",
      "ProcessName",
      "ProcessID",
      "Username",
      "ChildIndex",
    ]);
    expect(attach?.actions[0]?.outputs).toEqual([{ id: "trackingid", dataType: "text" }]);
    expect(attach?.writeAction).toBeUndefined();
    expect(attach?.conditions).toEqual([]);
    expect(attach).not.toBe(catalog.elementType("Application"));
    expect(catalog.elementType("Application", "BrowserLaunch")).toBe(
      catalog.elementType("Application"),
    );
    expect(catalog.elementType("WebTextEdit", "BrowserAttach")).toBe(
      catalog.elementType("WebTextEdit"),
    );
    expect(catalog.elementType("Application", "UnknownMode")).toBeUndefined();
    expect(catalog.elementType("UnknownElement", "BrowserAttach")).toBeUndefined();
    expect(catalog.elementTypes.filter((t) => t.id === "Application")).toHaveLength(1);
  });

  it("loads legacy dumps but requires re-extraction for an explicit Attach root", () => {
    const legacy = readFixture("catalog.json") as RawCatalogFile;
    delete legacy.browserAttachApplication;
    const old = createCatalog(legacy, readFixture("apptypes.json"));
    expect(old.browserAttachApplication).toBeUndefined();
    expect(old.elementType("Application", "BrowserAttach")).toBeUndefined();
    expect(old.elementType("Application", "BrowserLaunch")).toBe(old.elementType("Application"));
    expect(old.elementType("Application")).toBeDefined();
    expect(old.elementType("WebTextEdit", "BrowserAttach")).toBeDefined();
  });

  it("does not fill missing Attach operations from Launch", () => {
    const raw = readFixture("catalog.json") as RawCatalogFile;
    raw.browserAttachApplication = {
      id: "Application",
      appType: "Application",
      actions: [],
      readActions: [],
      writeActions: [],
      conditions: [],
    };
    const empty = createCatalog(raw, readFixture("apptypes.json"));
    expect(empty.elementType("Application", "BrowserAttach")?.actions).toEqual([]);
    expect(empty.elementType("Application", "BrowserAttach")?.readActions).toEqual([]);
    expect(empty.elementType("Application", "BrowserLaunch")?.actions.length).toBeGreaterThan(0);
  });

  it.each(["id", "appType"] as const)("rejects a non-Application Attach %s", (field) => {
    const raw = readFixture("catalog.json") as RawCatalogFile;
    const malformed = {
      ...raw,
      browserAttachApplication: { ...raw.browserAttachApplication, [field]: "WebElement" },
    };
    expect(() => createCatalog(malformed, readFixture("apptypes.json"))).toThrow(
      new RegExp(`browserAttachApplication\\.${field}`),
    );
  });

  it("rejects malformed Attach operations instead of falling back", () => {
    const raw = readFixture("catalog.json") as RawCatalogFile;
    const malformed = {
      ...raw,
      browserAttachApplication: { ...raw.browserAttachApplication, readActions: null },
    };
    expect(() => createCatalog(malformed, readFixture("apptypes.json"))).toThrow(
      /browserAttachApplication\.readActions/,
    );
  });
});

describe("catalogue errors", () => {
  it("reports a missing file with its path and how to generate it", () => {
    const dir = tempDirWith({});
    expect(() => loadCatalog(dir)).toThrow(CatalogFileError);
    expect(() => loadCatalog(dir)).toThrow(/catalog\.json.*catalog:extract/s);
  });

  it("reports a file that is not JSON", () => {
    const dir = tempDirWith({ "catalog.json": "{ nope", "apptypes.json": "[]" });
    expect(() => loadCatalog(dir)).toThrow(/catalog\.json is not valid JSON/);
  });

  it("reports schema problems with their JSON path", () => {
    const bad = structuredClone(readFixture("catalog.json")) as {
      browserElementTypes: { actions: { id?: string }[] }[];
    };
    delete bad.browserElementTypes[1]?.actions[0]?.id;
    try {
      createCatalog(bad, readFixture("apptypes.json"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogSchemaError);
      expect((error as CatalogSchemaError).issues[0]).toMatch(
        /^browserElementTypes\[1\]\.actions\[0\]\.id: /,
      );
    }
  });

  it("rejects duplicate element types", () => {
    const bad = structuredClone(readFixture("catalog.json")) as { browserElementTypes: unknown[] };
    bad.browserElementTypes.push(bad.browserElementTypes[1]);
    expect(() => createCatalog(bad, readFixture("apptypes.json"))).toThrow(
      /duplicate id\(s\) WebElement/,
    );
  });
});

// The real catalogue is generated locally (npm run catalog:extract) and never committed.
describe.runIf(existsSync(join(REAL_DIR, "catalog.json")))("real catalogue (.bpdev)", () => {
  it("loads, and BrowserLaunch declares its 5 named parameters", () => {
    const catalog = loadCatalog(REAL_DIR);
    expect(catalog.appType("BrowserLaunch")?.parameters.map((p) => p.name)).toEqual([
      "Path",
      "CommandLineParams",
      "prelaunchbrowser",
      "ProcessMode",
      "ExternalProcessTimeout",
    ]);
    expect(catalog.webIdentifiers).toHaveLength(38);
    expect(catalog.elementType("WebTextEdit")?.writeAction?.id).toBe("WebWrite");
  });
});
