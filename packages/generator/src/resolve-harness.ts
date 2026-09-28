import { SpecValidationError, type SpecIssue } from "./errors.js";
import type { ActionSpec, ObjectSpec, TestHarnessSpec } from "./ir.js";
import type { Param } from "./stages.js";
import { literalExpression } from "./resolve-object.js";

export interface ResolvedCall {
  readonly object: string;
  readonly action: ActionSpec;
  readonly inputs: readonly (Param & { readonly expression: string })[];
  /** Expected outputs, stored in the process data item of the same name. */
  readonly outputs: readonly (Param & { readonly into: string })[];
}

export interface ResolvedHarness {
  readonly name: string;
  readonly object: string;
  readonly calls: readonly ResolvedCall[];
  /** Process outputs: every expected output, once. */
  readonly outputs: readonly Param[];
  readonly cleanupAction: string;
  readonly cleanupObject: string;
}

/** Name of the test process generated for an object. */
export function harnessName(objectName: string): string {
  return `${objectName} - Test`;
}

/** Checks calls against their supplied objects; reports every problem at once. */
export function resolveHarness(
  spec: TestHarnessSpec,
  objectSpec: ObjectSpec | readonly ObjectSpec[],
): ResolvedHarness {
  const issues: SpecIssue[] = [];
  const report = (path: string, message: string): void => {
    issues.push({ path, message });
  };
  const supplied: readonly ObjectSpec[] = Array.isArray(objectSpec)
    ? objectSpec
    : [objectSpec as ObjectSpec];
  const objects = new Map<string, ObjectSpec>();
  supplied.forEach((object, i) => {
    if (objects.has(object.name)) {
      report(`objects[${i}].name`, `duplicate object name "${object.name}"`);
    } else {
      objects.set(object.name, object);
    }
  });
  const objectList = [...objects.keys()].join(", ") || "none";
  const missingObject = (name: string) =>
    `object "${name}" was not supplied (objects: ${objectList})`;
  if (!objects.has(spec.object)) {
    report("object", missingObject(spec.object));
  }
  const outputs = new Map<string, Param>();

  const calls = spec.calls.flatMap((call, i): ResolvedCall[] => {
    const path = `calls[${i}] "${call.action}"`;
    const objectName = call.object ?? spec.object;
    const object = objects.get(objectName);
    if (!object) {
      report(`${path}.object`, missingObject(objectName));
      return [];
    }
    const action = object.actions.find((a) => a.name === call.action);
    if (!action) {
      const actionList = object.actions.map((a) => a.name).join(", ");
      report(
        `${path}.action`,
        `"${call.action}" is not an action of ${object.name} (actions: ${actionList})`,
      );
      return [];
    }
    const given = call.inputs ?? {};
    if (action.published === false)
      report(`${path}.action`, `"${action.name}" is a private helper page`);
    const inputNames = action.inputs.map((p) => p.name);
    for (const name of Object.keys(given)) {
      if (!inputNames.includes(name)) {
        report(
          `${path}.inputs.${name}`,
          `not an input of ${action.name} (inputs: ${inputNames.join(", ") || "none"})`,
        );
      }
    }
    const inputs = action.inputs.flatMap((p) => {
      const expression =
        given[p.name] ??
        (p.defaultValue === undefined ? undefined : literalExpression(p.defaultValue));
      if (expression === undefined) {
        report(`${path}.inputs`, `missing input "${p.name}" of ${action.name}`);
        return [];
      }
      return [{ name: p.name, dataType: p.type, expression }];
    });
    const expected = Object.keys(call.expect ?? {}).flatMap((name) => {
      const param = action.outputs.find((p) => p.name === name);
      if (!param) {
        const names = action.outputs.map((p) => p.name).join(", ") || "none";
        report(`${path}.expect.${name}`, `not an output of ${action.name} (outputs: ${names})`);
        return [];
      }
      if (outputs.has(name)) {
        report(
          `${path}.expect.${name}`,
          "already expected from an earlier call: process outputs must be unique",
        );
        return [];
      }
      outputs.set(name, { name, dataType: param.type });
      return [{ name, dataType: param.type, into: name }];
    });
    return [{ object: objectName, action, inputs, outputs: expected }];
  });

  const cleanupObject = spec.cleanupObject ?? spec.object;
  const cleanupOwner = objects.get(cleanupObject);
  const cleanup = cleanupOwner?.actions.find((a) => a.name === spec.cleanupAction);
  if (!cleanupOwner) {
    report("cleanupObject", missingObject(cleanupObject));
  } else if (!cleanup) {
    const actionList = cleanupOwner.actions.map((a) => a.name).join(", ");
    report(
      "cleanupAction",
      `"${spec.cleanupAction}" is not an action of ${cleanupObject} (actions: ${actionList})`,
    );
  } else if (cleanup.inputs.length > 0) {
    report(
      "cleanupAction",
      `"${cleanup.name}" takes inputs, but the Recover block calls it without any`,
    );
  } else if (cleanup.published === false) {
    report("cleanupAction", `"${cleanup.name}" is a private helper page`);
  }

  if (issues.length > 0) throw new SpecValidationError("TestHarnessSpec", issues);
  return {
    name: spec.name ?? harnessName(spec.object),
    object: spec.object,
    calls,
    outputs: [...outputs.values()],
    cleanupAction: spec.cleanupAction,
    cleanupObject,
  };
}
