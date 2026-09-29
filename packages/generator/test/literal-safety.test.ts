import { childText, parseBpXml } from "@bpdev/model";
import { describe, expect, it } from "vitest";
import {
  generateObject,
  generateTestHarness,
  parseObjectSpec,
  SpecValidationError,
  type ParamSpec,
  type TestHarnessSpec,
} from "../src/index.js";
import { catalog, exampleObject, OPTIONS, pageId, stageNamed } from "./helpers.js";

function specWith(param: ParamSpec, direction: "inputs" | "outputs" = "inputs") {
  const spec = exampleObject();
  spec.actions = [
    {
      name: "Literal",
      description: "",
      inputs: [],
      outputs: [],
      steps: [],
      [direction]: [param],
    },
  ];
  return spec;
}

function parameter(type: ParamSpec["type"], defaultValue?: ParamSpec["defaultValue"]): ParamSpec {
  return { name: "Value", type, description: "", defaultValue };
}

describe("secret defaults", () => {
  it.each(["inputs", "outputs"] as const)(
    "rejects every password default in %s without leaking it",
    (direction) => {
      for (const value of ["synthetic-secret-ONLY-FOR-TEST", "", 0, false]) {
        const spec = specWith(parameter("password", value), direction);
        const harness: TestHarnessSpec = {
          object: spec.name,
          calls: [{ action: "Literal" }],
          cleanupAction: "Literal",
        };
        for (const run of [
          () => parseObjectSpec(spec),
          () => generateObject(spec, catalog, OPTIONS),
          () => generateTestHarness(harness, spec, catalog),
        ]) {
          expect(run).toThrow(SpecValidationError);
          try {
            run();
          } catch (error) {
            if (!(error instanceof SpecValidationError)) throw error;
            expect(error.issues.map((issue) => issue.path)).toEqual([
              `actions[0].${direction}[0].defaultValue`,
            ]);
            expect(error.issues[0]?.message).toContain("password defaults are forbidden");
            expect(String(error)).not.toContain("synthetic-secret-ONLY-FOR-TEST");
          }
        }
      }
    },
  );

  it("preserves password parameters without a default", () => {
    const spec = specWith(parameter("password"));
    const root = parseBpXml(generateObject(spec, catalog, OPTIONS).xml).root;
    const data = stageNamed(root, "Value", pageId(root, "Literal"));
    expect(childText(data.element, "datatype")).toBe("password");
    expect(childText(data.element, "initialvalue")).toBe("");
  });
});

describe("explicit temporal literal contract", () => {
  it.each([
    ["date", "0001-01-01"],
    ["date", "2000-02-29"],
    ["date", "2024-02-29"],
    ["date", "9999-12-31"],
    ["date", ""],
    ["datetime", "2026-09-29T12:34:56"],
    ["datetime", "2026-09-29T12:34:56.1234567"],
    ["datetime", "2026-09-29T12:34:56Z"],
    ["datetime", "2026-09-29T12:34:56.1+02:00"],
    ["datetime", "2026-09-29T00:00:00-14:00"],
    ["datetime", "2026-09-29T23:59:59+14:00"],
    ["datetime", ""],
  ] as const)("preserves %s literal %s without locale or timezone rewriting", (type, value) => {
    for (const direction of ["inputs", "outputs"] as const) {
      const spec = specWith(parameter(type, value), direction);
      const root = parseBpXml(generateObject(spec, catalog, OPTIONS).xml).root;
      const data = stageNamed(root, "Value", pageId(root, "Literal"));
      expect(childText(data.element, "initialvalue")).toBe(value);
    }
  });

  it.each([
    ["date", "not-a-date"],
    ["date", "2023-02-29"],
    ["date", "1900-02-29"],
    ["date", "0000-01-01"],
    ["date", "2026-04-31"],
    ["date", "2026-00-01"],
    ["date", "2026-13-01"],
    ["date", "2026-01-00"],
    ["date", "2026-1-1"],
    ["date", "29/09/2026"],
    ["date", "2026-09-29T00:00:00"],
    ["date", "2026-09-29\n"],
    ["date", 42],
    ["datetime", "2026-09-29"],
    ["datetime", "2026-09-29 12:34:56"],
    ["datetime", "2026-09-29T24:00:00"],
    ["datetime", "2026-09-29T12:60:00"],
    ["datetime", "2026-09-29T12:34:60"],
    ["datetime", "2026-09-29T12:34:56.12345678Z"],
    ["datetime", "2026-09-29T12:34:56+14:01"],
    ["datetime", "2026-09-29T12:34:56-15:00"],
    ["datetime", "2026-09-29T12:34:56+01:60"],
    ["datetime", "2026-09-29T12:34:56Z\n"],
    ["datetime", "2026-02-30T12:34:56Z"],
  ] as const)("rejects invalid %s literal %s before emitting XML", (type, value) => {
    expect(() => generateObject(specWith(parameter(type, value)), catalog, OPTIONS)).toThrow(
      SpecValidationError,
    );
  });
});

describe("unqualified Collection reads", () => {
  it.each(["BrowserLaunch", "BrowserAttach"] as const)(
    "rejects WebGetBounds in %s objects and harness dependencies",
    (kind) => {
      const spec = exampleObject();
      if (kind === "BrowserAttach") spec.application = { kind, name: "Browser" };
      spec.elements = [
        { key: "target", name: "Target", type: "WebElement", match: { wId: "target" } },
      ];
      spec.actions = [
        {
          name: "Read bounds",
          description: "",
          inputs: [],
          outputs: [],
          steps: [{ kind: "read", element: "target", action: "WebGetBounds", into: "Bounds" }],
        },
      ];
      expect(
        catalog.elementType("WebElement")?.readActions.find((a) => a.id === "WebGetBounds")
          ?.returns,
      ).toBe("collection");
      const harness: TestHarnessSpec = {
        object: spec.name,
        calls: [{ action: "Read bounds" }],
        cleanupAction: "Read bounds",
      };
      for (const run of [
        () => generateObject(spec, catalog, OPTIONS),
        () => generateTestHarness(harness, spec, catalog),
      ]) {
        expect(run).toThrow(
          /WebGetBounds returns collection: native Collection generation is not qualified/,
        );
      }
    },
  );
});
