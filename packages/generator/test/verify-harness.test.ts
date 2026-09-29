import { getAttr, parseBpXml } from "@bpdev/model";
import { describe, expect, it } from "vitest";
import {
  generateTestHarness,
  verifyHarnessOutputs,
  SpecValidationError,
  type GeneratedFile,
  type HarnessAssertion,
  type HarnessAssertionManifest,
  type HarnessOutput,
  type ParamSpec,
  type TestHarnessSpec,
} from "../src/index.js";
import { catalog, descendants, exampleHarness, exampleObject, stageNamed } from "./helpers.js";

function generated(type: ParamSpec["type"] = "text", expected = "hello") {
  const object = exampleObject();
  object.actions = [
    {
      name: "Observe",
      description: "",
      inputs: [],
      outputs: [{ name: "Result", type, description: "" }],
      steps: [],
    },
    { name: "Cleanup", description: "", inputs: [], outputs: [], steps: [] },
  ];
  const spec: TestHarnessSpec = {
    object: object.name,
    calls: [{ action: "Observe", expect: { Result: expected } }],
    cleanupAction: "Cleanup",
  };
  return generateTestHarness(spec, object, catalog);
}

function output(value: string | undefined = "hello", type = "text"): HarnessOutput {
  return { name: "Result", type, value };
}

describe("assertion manifest emitted with harness", () => {
  it("changing only expected changes the verdict for the same completed-run outputs", () => {
    const spec = exampleHarness();
    const object = exampleObject();
    const original = generateTestHarness(spec, object, catalog);
    const expectedCall = spec.calls.find((c) => c.expect !== undefined);
    if (!expectedCall?.expect) throw new Error("The public example must assert an output");
    const name = Object.keys(expectedCall.expect)[0];
    if (!name) throw new Error("Missing example assertion");
    expectedCall.expect[name] = "IMPOSSIBLE_EXPECTED_VALUE_FOR_AUDIT";
    const changed = generateTestHarness(spec, object, catalog);
    const completedRunOutputs = original.assertionManifest.assertions.map((a) => ({
      name: a.outputName,
      type: a.type,
      value: a.expected,
    }));
    expect(verifyHarnessOutputs(original.assertionManifest, completedRunOutputs).status).toBe(
      "passed",
    );
    expect(verifyHarnessOutputs(changed.assertionManifest, completedRunOutputs).status).toBe(
      "failed",
    );
    expect(changed.assertionManifest).not.toEqual(original.assertionManifest);
    expect(changed.xml).toBe(original.xml); // Expectations belong to the sidecar, not to BP expressions.
    const compatible: GeneratedFile = original;
    expect(compatible.fileName).toBe(original.fileName);
    expect(original.assertions).toBe(original.assertionManifest.assertions);
    expect(verifyHarnessOutputs(original.assertions, completedRunOutputs)).toEqual(
      verifyHarnessOutputs(original.assertionManifest, completedRunOutputs),
    );
  });

  it("binds each assertion to its call owner, index, End output and data type", () => {
    const primary = exampleObject();
    primary.actions = [{ name: "Cleanup", description: "", inputs: [], outputs: [], steps: [] }];
    const secondary = structuredClone(primary);
    secondary.name = "Other object";
    secondary.actions.push({
      name: "Read",
      description: "",
      inputs: [],
      outputs: [{ name: "Result", type: "number", description: "" }],
      steps: [],
    });
    const spec: TestHarnessSpec = {
      name: "Named process",
      object: primary.name,
      cleanupAction: "Cleanup",
      calls: [
        { action: "Cleanup" },
        { object: secondary.name, action: "Read", expect: { Result: "42" } },
      ],
    };
    const result = generateTestHarness(spec, [primary, secondary], catalog);
    expect(result.assertionManifest).toEqual({
      version: 1,
      processName: "Named process",
      assertions: [
        {
          callIndex: 1,
          object: secondary.name,
          action: "Read",
          outputName: "Result",
          type: "number",
          expected: "42",
        },
      ],
    });
    const root = parseBpXml(result.xml).root;
    for (const stage of ["Read", "End"]) {
      expect(
        descendants(stageNamed(root, stage).element, "output").map((p) => [
          getAttr(p, "name"),
          getAttr(p, "type"),
          getAttr(p, "stage"),
        ]),
      ).toEqual([["Result", "number", "Result"]]);
    }
    const roundTrip = JSON.parse(
      JSON.stringify(result.assertionManifest),
    ) as HarnessAssertionManifest;
    const snapshot = [output("42.0", "number")];
    const before = structuredClone({ roundTrip, snapshot });
    expect(verifyHarnessOutputs(roundTrip, snapshot).status).toBe("passed");
    expect({ roundTrip, snapshot }).toEqual(before);
  });

  it("does not turn an assertion-free harness into a verified success", () => {
    const spec = exampleHarness();
    spec.calls.forEach((c) => {
      delete c.expect;
    });
    const result = generateTestHarness(spec, exampleObject(), catalog);
    expect(verifyHarnessOutputs(result.assertionManifest, [])).toEqual({
      status: "not_run",
      assertions: [],
    });
  });

  it("rejects secret assertions without putting the secret in the error", () => {
    expect(() => generated("password", "TEST-SECRET-NEVER-PERSIST")).toThrow(
      /password assertions are forbidden/,
    );
    try {
      generated("password", "TEST-SECRET-NEVER-PERSIST");
    } catch (error) {
      expect(String(error)).not.toContain("TEST-SECRET-NEVER-PERSIST");
    }
  });

  it.each([
    ["number", "NaN"],
    ["flag", "yes"],
    ["date", "2026-02-30"],
    ["datetime", "yesterday"],
  ] as const)("rejects invalid %s expectation", (type, value) => {
    expect(() => generated(type, value)).toThrow(SpecValidationError);
  });
});

describe("pure scalar output verification", () => {
  it.each([
    { outputs: [], reason: "missing_output" },
    { outputs: [{ name: "Result", type: "text", value: undefined }], reason: "missing_value" },
    { outputs: [output("hello", "number")], reason: "type_mismatch" },
    { outputs: [output("wrong")], reason: "value_mismatch" },
    { outputs: [output(), output()], reason: "duplicate_output" },
  ])("distinguishes $reason", ({ outputs, reason }) => {
    expect(verifyHarnessOutputs(generated().assertionManifest, outputs)).toEqual({
      status: "failed",
      assertions: [{ callIndex: 0, outputName: "Result", status: "failed", reason }],
    });
  });

  it("evaluates all outputs, ignoring extras but never silently merging duplicates", () => {
    const manifest = generated().assertionManifest;
    const first = manifest.assertions[0];
    if (!first) throw new Error("Missing assertion");
    const second: HarnessAssertion = {
      ...first,
      outputName: "Other",
      expected: "other",
      callIndex: 2,
    };
    const result = verifyHarnessOutputs({ ...manifest, assertions: [first, second] }, [
      output(),
      { name: "Extra", type: "password", value: "TEST-SECRET" },
    ]);
    expect(result.assertions.map((a) => a.status)).toEqual(["passed", "failed"]);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("TEST-SECRET");
  });

  it.each([
    ["text", "", "", "passed"],
    ["text", "hello", " hello", "failed"],
    ["number", "42", "42.00", "passed"],
    ["number", "0", "-0.000", "passed"],
    ["number", "0.001", "1e-3", "passed"],
    ["number", "9007199254740992", "9007199254740993", "failed"],
    ["flag", "True", "true", "passed"],
    ["flag", "False", "True", "failed"],
    ["date", "2024-02-29", "2024-02-29", "passed"],
    ["datetime", "2026-09-29T12:34:56", "2026-09-29T12:34:56Z", "failed"],
    ["datetime", "2026-09-29T12:34:56.1234567Z", "2026-09-29T12:34:56.1234568Z", "failed"],
  ] as const)("compares %s expected %s against %s as %s", (type, expected, actual, status) => {
    expect(
      verifyHarnessOutputs(generated(type, expected).assertionManifest, [output(actual, type)])
        .status,
    ).toBe(status);
  });

  it.each([
    ["number", "1", "NaN"],
    ["number", "1", "1,0"],
    ["number", "1", ""],
    ["number", "1", "1\n"],
    ["flag", "True", "True\n"],
    ["flag", "True", "1"],
    ["date", "2026-01-01", "2026-02-30"],
  ] as const)("reports invalid %s value %s / %s", (type, expected, actual) => {
    expect(
      verifyHarnessOutputs(generated(type, expected).assertionManifest, [output(actual, type)])
        .assertions[0],
    ).toMatchObject({ status: "failed", reason: "invalid_value" });
  });

  it("does not echo an actual secret under an unexpected type", () => {
    const result = verifyHarnessOutputs(generated().assertionManifest, [
      output("TEST-SECRET", "password"),
    ]);
    expect(result.assertions[0]).toMatchObject({ reason: "type_mismatch" });
    expect(JSON.stringify(result)).not.toContain("TEST-SECRET");
  });

  it("fails closed for a corrupted persisted manifest", () => {
    const manifest = generated().assertionManifest;
    const first = manifest.assertions[0];
    if (!first) throw new Error("Missing assertion");
    for (const broken of [
      { ...manifest, version: 99 },
      { ...manifest, assertions: [first, first] },
      { ...manifest, assertions: [{ ...first, type: "password", expected: "TEST-SECRET" }] },
      { ...manifest, assertions: [{ ...first, type: "number", expected: "NaN" }] },
    ]) {
      expect(() => verifyHarnessOutputs(broken as HarnessAssertionManifest, [output()])).toThrow(
        SpecValidationError,
      );
    }
  });
});
