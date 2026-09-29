import { z } from "zod";
import type { GeneratedFile } from "./document.js";
import { SpecValidationError } from "./errors.js";
import { scalarComparisonKey } from "./scalar-values.js";

/** JSON-safe sidecar: store alongside the exact generated .bpprocess, not inside BP XML. */
const manifestSchema = z.strictObject({
  version: z.literal(1),
  processName: z.string().min(1),
  assertions: z.array(
    z.strictObject({
      callIndex: z.number().int().nonnegative(),
      object: z.string().min(1),
      action: z.string().min(1),
      outputName: z.string().min(1),
      type: z.enum(["text", "number", "flag", "date", "datetime"]),
      expected: z.string(),
    }),
  ),
});

export type HarnessAssertion = Readonly<z.infer<typeof manifestSchema>["assertions"][number]>;
export interface HarnessAssertionManifest {
  readonly version: 1;
  readonly processName: string;
  readonly assertions: readonly HarnessAssertion[];
}

/** Backwards-compatible GeneratedFile with the expectations required by a runner. */
export interface HarnessGeneratedFile extends GeneratedFile {
  readonly assertions: readonly HarnessAssertion[];
  readonly assertionManifest: HarnessAssertionManifest;
}
export type GeneratedHarness = HarnessGeneratedFile;

/** Structurally accepts bridge SessionOutput; no bridge dependency and no raw XML needed. */
export interface HarnessOutput {
  readonly name: string;
  readonly type: string;
  readonly value: string | undefined;
}

export type HarnessAssertionFailure =
  | "missing_output"
  | "duplicate_output"
  | "missing_value"
  | "type_mismatch"
  | "invalid_value"
  | "value_mismatch";

/** Values are not echoed, including when an unexpected output is typed password. */
export type HarnessAssertionResult = {
  readonly callIndex: number;
  readonly outputName: string;
} & (
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly reason: HarnessAssertionFailure }
);

export interface HarnessVerification {
  readonly status: "passed" | "failed" | "not_run";
  readonly assertions: readonly HarnessAssertionResult[];
}

/**
 * Pure business verification of a final output snapshot. The caller must separately require
 * successful execution and correlate outputs with this process/run; Completed is not an
 * assertion and a passing snapshot does not prove completion. Extra outputs are ignored.
 * No assertions => not_run. Invalid manifests throw a value-free SpecValidationError rather
 * than silently passing (also validates a manifest reloaded from a JSON sidecar).
 */
export function verifyHarnessOutputs(
  manifest: HarnessAssertionManifest | readonly HarnessAssertion[],
  outputs: readonly HarnessOutput[],
): HarnessVerification {
  const parsed = manifestSchema.safeParse(
    Array.isArray(manifest)
      ? { version: 1, processName: "(assertions only)", assertions: manifest }
      : manifest,
  );
  if (!parsed.success) {
    throw new SpecValidationError("HarnessAssertionManifest", [
      { path: "manifest", message: "invalid version, metadata or scalar assertion shape" },
    ]);
  }
  const names = new Set<string>();
  for (const [index, assertion] of parsed.data.assertions.entries()) {
    if (
      names.has(assertion.outputName) ||
      scalarComparisonKey(assertion.type, assertion.expected) === undefined
    ) {
      throw new SpecValidationError("HarnessAssertionManifest", [
        { path: `assertions[${index}]`, message: "duplicate output or invalid expected literal" },
      ]);
    }
    names.add(assertion.outputName);
  }

  const assertions = parsed.data.assertions.map((assertion): HarnessAssertionResult => {
    const base = { callIndex: assertion.callIndex, outputName: assertion.outputName };
    const fail = (reason: HarnessAssertionFailure): HarnessAssertionResult => ({
      ...base,
      status: "failed",
      reason,
    });
    const candidates = outputs.filter((o) => o.name === assertion.outputName);
    const actual = candidates[0];
    if (!actual) return fail("missing_output");
    if (candidates.length !== 1) return fail("duplicate_output");
    if (actual.type !== assertion.type) return fail("type_mismatch");
    if (actual.value === undefined) return fail("missing_value");
    if (typeof actual.value !== "string") return fail("invalid_value");
    const key = scalarComparisonKey(actual.type, actual.value);
    if (key === undefined) return fail("invalid_value");
    return key === scalarComparisonKey(assertion.type, assertion.expected)
      ? { ...base, status: "passed" }
      : fail("value_mismatch");
  });
  return {
    status:
      assertions.length === 0
        ? "not_run"
        : assertions.some((a) => a.status === "failed")
          ? "failed"
          : "passed",
    assertions,
  };
}
