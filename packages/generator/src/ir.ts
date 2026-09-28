/**
 * The IR (docs/05-ir.md): the only format the LLM writes. Validated with zod (unknown keys are
 * errors, so a misspelt field is reported instead of silently ignored), then checked against
 * the catalogue by resolve-object.ts / resolve-harness.ts.
 */
import { z } from "zod";
import { SpecValidationError, type SpecIssue } from "./errors.js";

const nonEmpty = z.string().min(1);
const expressions = z.record(z.string(), z.string());
const literal = z.union([z.string(), z.number(), z.boolean()]);
/** Runtime values for Application Modeller's Dynamic attributes, not action arguments. */
const elementParameters = z.record(nonEmpty, nonEmpty).optional();

export const paramSpecSchema = z.strictObject({
  name: nonEmpty,
  type: z.enum(["text", "number", "flag", "date", "datetime", "password"]),
  description: z.string(),
  defaultValue: literal.optional(),
});

export const exceptionSpecSchema = z.strictObject({
  /** `System Exception`, `Business Exception` or any other Blue Prism exception type. */
  type: nonEmpty,
  /** Plain text (the generator turns it into a Blue Prism string expression). */
  detail: z.string(),
});

export const stepSpecSchema = z.discriminatedUnion("kind", [
  /** Navigate `Launch` on the application. */
  z.strictObject({ kind: z.literal("launch") }),
  /** Navigate `WebCloseApplication` on the application. */
  z.strictObject({ kind: z.literal("close") }),
  /** Read connection state, attach only if disconnected. Normally placed on a shared Attach page. */
  z.strictObject({ kind: z.literal("ensureAttached"), args: expressions.optional() }),
  z.strictObject({
    kind: z.literal("callPage"),
    page: nonEmpty,
    inputs: expressions.optional(),
    outputs: expressions.optional(),
  }),
  z.strictObject({
    kind: z.literal("waitFor"),
    /** Semantic stage name, e.g. Wait for written value, visible in Studio and logs. */
    name: nonEmpty.optional(),
    element: nonEmpty,
    /** A condition of the catalogue; `WebCheckExists` when left out. */
    condition: nonEmpty.optional(),
    timeoutSeconds: z.union([z.number().positive(), nonEmpty]),
    /** BP expression: True/False for flags, e.g. [Expected Text] for text. */
    expected: nonEmpty.optional(),
    args: expressions.optional(),
    params: elementParameters,
    onTimeout: exceptionSpecSchema,
  }),
  /** `value` is a Blue Prism expression, e.g. `[First Name]`. */
  z.strictObject({
    kind: z.literal("write"),
    name: nonEmpty.optional(),
    element: nonEmpty,
    value: nonEmpty,
    args: expressions.optional(),
    params: elementParameters,
  }),
  /** `action` is a read action of the catalogue; `into` a data item of the page. */
  z.strictObject({
    kind: z.literal("read"),
    name: nonEmpty.optional(),
    element: nonEmpty,
    action: nonEmpty,
    into: nonEmpty,
    args: expressions.optional(),
    params: elementParameters,
  }),
  /** `action` is an action of the catalogue; `args` are Blue Prism expressions by argument id. */
  z.strictObject({
    kind: z.literal("act"),
    name: nonEmpty.optional(),
    element: nonEmpty,
    action: nonEmpty,
    args: expressions.optional(),
    params: elementParameters,
  }),
  z.strictObject({ kind: z.literal("calc"), expression: nonEmpty, into: nonEmpty }),
  z.strictObject({ kind: z.literal("raise"), exception: exceptionSpecSchema }),
]);

export const actionSpecSchema = z.strictObject({
  /** Page name, e.g. `Set Field First Name`, `Click Button - Start`, `Get Start Text`. */
  name: nonEmpty,
  description: z.string(),
  /** Internal helpers such as Attach need not be exposed to a process. */
  published: z.boolean().optional(),
  inputs: z.array(paramSpecSchema),
  outputs: z.array(paramSpecSchema),
  steps: z.array(stepSpecSchema),
});

const identifierValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const elementSpecSchema = z.strictObject({
  /** Stable id inside the IR (GUIDs and step references). */
  key: nonEmpty,
  name: nonEmpty,
  /** AMI element type: `WebButton`, `WebTextEdit`, `WebElement`… */
  type: nonEmpty,
  /** Identifiers used for matching (`inuse`). */
  match: identifierValues,
  /** Identifiers whose values are supplied by each calling stage (e.g. wXPath). */
  dynamic: z.array(nonEmpty).optional(),
  /** Observed values kept for reference, not used for matching. */
  captured: identifierValues.optional(),
  rationale: z.string().optional(),
});

export const applicationSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("BrowserLaunch"),
    name: nonEmpty,
    browserPath: nonEmpty,
    url: nonEmpty,
    /** Appended to the URL in `CommandLineParams`. `{robotProfileDir}` is replaced at generation. */
    extraArgs: z.array(z.string()).optional(),
  }),
  z.strictObject({
    kind: z.literal("BrowserAttach"),
    name: nonEmpty,
    /** Values by catalogue parameter name; the others keep the catalogue default. */
    parameters: z.record(z.string(), z.string()).optional(),
  }),
]);

export const objectSpecSchema = z.strictObject({
  /** `<Application> - <Screen>`, e.g. `RPA Challenge - Form`. */
  name: nonEmpty,
  description: z.string(),
  runMode: z.enum(["Foreground", "Background", "Exclusive"]),
  application: applicationSpecSchema,
  elements: z.array(elementSpecSchema),
  /** One action = one page, published unless explicitly private. */
  actions: z.array(actionSpecSchema),
});

export const testHarnessSpecSchema = z.strictObject({
  /** Optional name for separate positive/negative integration scenarios. */
  name: nonEmpty.optional(),
  /** Name of the object under test. */
  object: nonEmpty,
  calls: z
    .array(
      z.strictObject({
        action: nonEmpty,
        /** Defaults to the harness's primary object; supports separated screen/lifecycle objects. */
        object: nonEmpty.optional(),
        /** Blue Prism expressions by input name, e.g. `{ "First Name": "\"Claude\"" }`. */
        inputs: expressions.optional(),
        /** Expected literal values by output name; these outputs become process outputs. */
        expect: z.record(z.string(), z.string()).optional(),
      }),
    )
    .min(1),
  /** Called from the Recover block before the exception is rethrown, e.g. `Terminate`. */
  cleanupAction: nonEmpty,
  cleanupObject: nonEmpty.optional(),
});

export type ParamSpec = z.infer<typeof paramSpecSchema>;
export type ExceptionSpec = z.infer<typeof exceptionSpecSchema>;
export type StepSpec = z.infer<typeof stepSpecSchema>;
export type ActionSpec = z.infer<typeof actionSpecSchema>;
export type ElementSpec = z.infer<typeof elementSpecSchema>;
export type ApplicationSpec = z.infer<typeof applicationSpecSchema>;
export type ObjectSpec = z.infer<typeof objectSpecSchema>;
export type TestHarnessSpec = z.infer<typeof testHarnessSpecSchema>;

/** Validates the shape of an ObjectSpec (not its consistency with the catalogue). */
export function parseObjectSpec(value: unknown): ObjectSpec {
  return parse(objectSpecSchema, value, "ObjectSpec");
}

/** Validates the shape of a TestHarnessSpec (not its consistency with the object). */
export function parseTestHarnessSpec(value: unknown): TestHarnessSpec {
  return parse(testHarnessSpecSchema, value, "TestHarnessSpec");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, spec: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues: SpecIssue[] = result.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
  throw new SpecValidationError(spec, issues);
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((key, i) => (typeof key === "number" ? `[${key}]` : `${i === 0 ? "" : "."}${String(key)}`))
    .join("");
}
