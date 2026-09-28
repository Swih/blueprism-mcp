import { describe, expect, it } from "vitest";
import {
  BpViewError,
  el,
  listAppElements,
  listPages,
  listReleaseContents,
  listStages,
  parseBpXml,
  readProcessHeader,
  type BpElement,
} from "../src/index.js";
import { readFixture } from "./fixtures.js";

const load = (name: string): BpElement => parseBpXml(readFixture(name)).root;
const withoutElement = <T extends { element: BpElement }>({ element: _, ...rest }: T) => rest;

describe("process views", () => {
  const echo = load("MCP Test - Echo.bpprocess");

  it("reads the header", () => {
    expect(readProcessHeader(echo)).toEqual({
      name: "MCP Test - Echo",
      type: "process",
      bpversion: "7.5.1.18099",
      runmode: undefined,
      preferredid: "6d1c2f0e-4b7a-4c55-9a3e-0e5b7c3d9a01",
    });
  });

  it("lists stages with their links", () => {
    const stages = listStages(echo);
    expect(stages).toHaveLength(14);
    expect(listPages(echo)).toEqual([]);
    expect(withoutElement(stages[2] as (typeof stages)[number])).toEqual({
      id: "a0000000-0000-4000-8000-000000000003",
      name: "Fail requested?",
      type: "Decision",
      pageId: undefined,
      onSuccess: undefined,
      onTrue: "a0000000-0000-4000-8000-000000000004",
      onFalse: "a0000000-0000-4000-8000-000000000005",
    });
  });

  it("lists pages and assigns stages to them", () => {
    const object = load("SPIKE - RPA Challenge.bpobject");
    expect(readProcessHeader(object)).toMatchObject({ type: "object", runmode: "Foreground" });
    const pages = listPages(object);
    expect(pages.map((p) => [p.name, p.type])).toEqual([
      ["Clean Up", "CleanUp"],
      ["Launch", "Normal"],
      ["Diagnose", "Normal"],
      ["Write First Name", "Normal"],
      ["Terminate", "Normal"],
    ]);
    const launch = pages[1];
    const launchStages = listStages(object).filter((s) => s.pageId === launch?.id);
    expect(launchStages.map((s) => s.type)).toContain("Navigate");
  });

  it("refuses an element that is not a process", () => {
    expect(() => listStages(el("release"))).toThrow(BpViewError);
    expect(() => listStages(el("process", {}, [el("stage", { name: "x" })]))).toThrow(BpViewError);
  });
});

describe("application model view", () => {
  const elements = listAppElements(load("SPIKE - RPA Challenge.bpobject"));

  it("lists the application root and its elements", () => {
    expect(elements.map((e) => [e.name, e.type])).toEqual([
      ["RPA Challenge", "Application"],
      ["Home - Start Button", "WebButton"],
      ["Form - First Name Field", "WebTextEdit"],
    ]);
    const [root, button] = elements;
    expect(root?.parentId).toBeUndefined();
    expect(button?.parentId).toBe(root?.id);
  });

  it("reads attributes with their in-use flag and value", () => {
    const button = elements[1];
    expect(button?.attributes).toHaveLength(38);
    expect(button?.attributes.filter((a) => a.inUse)).toEqual([
      { name: "wCssSelector", inUse: true, datatype: "text", value: "button.btn-large" },
      { name: "wElementType", inUse: true, datatype: "text", value: "BUTTON" },
    ]);
    expect(button?.attributes.find((a) => a.name === "wX")).toEqual({
      name: "wX",
      inUse: false,
      datatype: "number",
      value: "0",
    });
  });

  it("is empty for a process", () => {
    expect(listAppElements(load("MCP Test - Echo.bpprocess"))).toEqual([]);
  });
});

// Blue Prism's own export of an item we generated reads the same through the views.
describe.each([
  ["SPIKE - RPA Challenge.bpobject", "bp-export/BPA Objet - SPIKE - RPA Challenge.xml"],
  [
    "SPIKE - RPA Challenge Test.bpprocess",
    "bp-export/BPA Processus - SPIKE - RPA Challenge Test.xml",
  ],
  ["MCP Test - Echo.bpprocess", "bp-export/BPA Processus - MCP Test - Echo.xml"],
])("%s vs its Blue Prism export", (ours, exported) => {
  const a = load(ours);
  const b = load(exported);

  it("has the same header, pages, stages and application model", () => {
    expect(readProcessHeader(b)).toEqual(readProcessHeader(a));
    expect(listPages(b).map(withoutElement)).toEqual(listPages(a).map(withoutElement));
    expect(listStages(b).map(withoutElement)).toEqual(listStages(a).map(withoutElement));
    const app = (root: BpElement) => listAppElements(root).map(({ element: _, ...rest }) => rest);
    expect(app(b)).toEqual(app(a));
  });
});

describe("release view", () => {
  const release = load("MCP Test - Release.bprelease");

  it("lists processes and objects, skipping groups", () => {
    const entries = listReleaseContents(release);
    expect(entries.map((e) => [e.kind, e.name])).toEqual([
      ["process", "MCP Test - Echo"],
      ["object", "SPIKE - Ping"],
    ]);
    expect(entries.map((e) => readProcessHeader(e.process).name)).toEqual([
      "MCP Test - Echo",
      "SPIKE - Ping",
    ]);
    expect(listStages(entries[0]?.process as BpElement)).toHaveLength(14);
  });

  it("keeps the namespaces of the release", () => {
    expect(release.attributes).toEqual([
      { name: "xmlns:bpr", value: "http://www.blueprism.co.uk/product/release" },
    ]);
  });

  it("refuses a document that is not a release", () => {
    expect(() => listReleaseContents(el("process"))).toThrow(BpViewError);
  });
});
