/**
 * Checks an ObjectSpec against the catalogue and against itself, and resolves every reference
 * (element types, actions, conditions, arguments, data items). Reports all problems at once
 * with their location; the builders then only map the resolved plan to XML.
 */
import type {
  AppTypeInfo,
  Catalog,
  ConditionInfo,
  ElementTypeInfo,
  OperationInfo,
  WebIdentifierInfo,
} from "@bpdev/catalog";
import { SpecValidationError, type SpecIssue } from "./errors.js";
import type { ActionSpec, ElementSpec, ExceptionSpec, ObjectSpec } from "./ir.js";
import { textExpression, type Param } from "./stages.js";

/** Pages every object has; an action cannot take their name. */
export const INITIALISE_PAGE = "Initialise";
export const CLEAN_UP_PAGE = "Clean Up";

const DEFAULT_WAIT_CONDITION = "WebCheckExists";
const EMPTY_VALUES: Readonly<Record<string, string>> = { text: "", number: "0", flag: "False" };

export interface ResolvedAttribute {
  readonly id: string;
  readonly dataType: string;
  readonly value: string;
  readonly inUse: boolean;
  readonly dynamic: boolean;
  readonly userVisible: boolean;
}

export interface ResolvedElement {
  readonly spec: ElementSpec;
  readonly type: ElementTypeInfo;
  /** Every web identifier of the catalogue, in its order (G3). */
  readonly attributes: readonly ResolvedAttribute[];
}

/** `element` undefined = the application root element. */
export type ResolvedStep =
  | {
      readonly kind: "navigate";
      readonly label: string;
      readonly element: ResolvedElement | undefined;
      readonly operation: OperationInfo;
      readonly args: Readonly<Record<string, string>>;
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "wait";
      readonly label: string;
      readonly element: ResolvedElement;
      readonly condition: ConditionInfo;
      readonly timeoutSeconds: number | string;
      readonly expected: string;
      readonly args: Readonly<Record<string, string>>;
      readonly params: Readonly<Record<string, string>>;
      readonly onTimeout: ExceptionSpec;
    }
  | {
      readonly kind: "write";
      readonly label: string;
      readonly element: ResolvedElement;
      readonly operation: OperationInfo;
      readonly value: string;
      readonly args: Readonly<Record<string, string>>;
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "read";
      readonly label: string;
      readonly element: ResolvedElement;
      readonly operation: OperationInfo;
      readonly into: string;
      readonly args: Readonly<Record<string, string>>;
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "ensureAttached";
      readonly read: OperationInfo;
      readonly attach: OperationInfo;
      readonly args: Readonly<Record<string, string>>;
      readonly into: string;
    }
  | {
      readonly kind: "callPage";
      readonly page: string;
      readonly inputs: readonly (Param & { readonly expression: string })[];
      readonly outputs: readonly (Param & { readonly into: string })[];
    }
  | { readonly kind: "calc"; readonly expression: string; readonly into: string }
  | { readonly kind: "raise"; readonly exception: ExceptionSpec };

export interface ResolvedAction {
  readonly spec: ActionSpec;
  readonly inputs: readonly Param[];
  readonly outputs: readonly Param[];
  /** Inputs, outputs, then read / calc targets, each once. */
  readonly dataItems: readonly Param[];
  readonly steps: readonly ResolvedStep[];
}

export interface ResolvedObject {
  readonly spec: ObjectSpec;
  readonly appType: AppTypeInfo;
  /** Every parameter of the application type, in catalogue order, with its value (G2). */
  readonly appParameters: readonly { readonly name: string; readonly value: string }[];
  readonly elements: readonly ResolvedElement[];
  readonly actions: readonly ResolvedAction[];
}

/**
 * `placeholders` replaces `{name}` in the application spec; `undefined` leaves them as they
 * are (validation only, e.g. when a test harness checks its object).
 */
export function resolveObject(
  spec: ObjectSpec,
  catalog: Catalog,
  placeholders: Readonly<Record<string, string | undefined>> | undefined,
): ResolvedObject {
  const issues: SpecIssue[] = [];
  const report = (path: string, message: string): void => {
    issues.push({ path, message });
  };

  const application = resolveApplication(spec, catalog, placeholders, report);
  const applicationType = catalog.elementType("Application", spec.application.kind);
  if (!applicationType) report("application", "the catalogue has no Application element type");
  const elements = resolveElements(spec, catalog, report);
  const actions = spec.actions.map((action, i) =>
    resolveAction(
      spec,
      action,
      `actions[${i}] "${action.name}"`,
      applicationType,
      elements,
      report,
    ),
  );
  checkActionNames(spec, report);
  checkPageCycles(spec, report);

  if (issues.length > 0 || !application) throw new SpecValidationError("ObjectSpec", issues);
  return {
    spec,
    appType: application.appType,
    appParameters: application.parameters,
    elements: [...elements.resolved.values()],
    actions,
  };
}

type Report = (path: string, message: string) => void;

function resolveApplication(
  spec: ObjectSpec,
  catalog: Catalog,
  placeholders: Readonly<Record<string, string | undefined>> | undefined,
  report: Report,
): { appType: AppTypeInfo; parameters: ResolvedObject["appParameters"] } | undefined {
  const app = spec.application;
  const appType = catalog.appType(app.kind);
  if (!appType) {
    report("application.kind", `application type "${app.kind}" is not in the catalogue`);
    return undefined;
  }
  const substitute = (value: string, path: string): string =>
    value.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      if (placeholders === undefined || !(name in placeholders)) return placeholder;
      const replacement = placeholders[name];
      if (replacement) return replacement;
      report(path, `uses ${placeholder}: pass options.${name} to generate this object`);
      return placeholder;
    });

  let values: Record<string, string>;
  if (app.kind === "BrowserLaunch") {
    const args = (app.extraArgs ?? []).map((a, i) => substitute(a, `application.extraArgs[${i}]`));
    values = {
      Path: substitute(app.browserPath, "application.browserPath"),
      CommandLineParams: [substitute(app.url, "application.url"), ...args].join(" "),
    };
  } else {
    values = app.parameters ?? {};
  }
  const known = appType.parameters.map((p) => p.name);
  for (const name of Object.keys(values)) {
    if (!known.includes(name)) {
      report(
        app.kind === "BrowserLaunch" ? "application" : `application.parameters.${name}`,
        `"${name}" is not a parameter of ${app.kind} (parameters: ${known.join(", ")})`,
      );
    }
  }
  return {
    appType,
    parameters: appType.parameters.map((p) => ({
      name: p.name,
      value: values[p.name] ?? p.defaultValue ?? "",
    })),
  };
}

interface Elements {
  readonly declared: ReadonlySet<string>;
  readonly resolved: ReadonlyMap<string, ResolvedElement>;
}

function resolveElements(spec: ObjectSpec, catalog: Catalog, report: Report): Elements {
  const declared = new Set<string>();
  const names = new Set<string>();
  const resolved = new Map<string, ResolvedElement>();
  const webTypes = catalog.elementTypes.filter((t) => t.appType !== "Application").map((t) => t.id);

  spec.elements.forEach((element, i) => {
    const path = `elements[${i}] "${element.key}"`;
    if (declared.has(element.key)) report(path, `duplicate key "${element.key}"`);
    if (names.has(element.name)) report(`${path}.name`, `duplicate element name "${element.name}"`);
    declared.add(element.key);
    names.add(element.name);

    const type = catalog.elementType(element.type);
    if (!type || type.appType === "Application") {
      report(
        `${path}.type`,
        `"${element.type}" is not an element type of the catalogue (types: ${webTypes.join(", ")})`,
      );
      return;
    }
    const dynamic = element.dynamic ?? [];
    if (Object.keys(element.match).length === 0 && dynamic.length === 0) {
      report(`${path}.match`, "needs at least one identifier, or the element matches anything");
    }
    const identifiers = new Map(catalog.webIdentifiers.map((w) => [w.id, w]));
    if (new Set(dynamic).size !== dynamic.length)
      report(`${path}.dynamic`, "duplicate dynamic identifier");
    for (const id of dynamic) {
      if (!identifiers.has(id)) report(`${path}.dynamic`, `unknown web identifier "${id}"`);
      if (id in element.match)
        report(`${path}.dynamic`, `"${id}" is also in match: choose static or dynamic`);
    }
    const captured = element.captured ?? {};
    for (const [group, values] of [
      ["match", element.match],
      ["captured", captured],
    ] as const) {
      for (const [id, value] of Object.entries(values)) {
        const identifier = identifiers.get(id);
        if (!identifier) {
          const known = catalog.webIdentifiers.map((w) => w.id).join(", ");
          report(`${path}.${group}.${id}`, `unknown web identifier (identifiers: ${known})`);
        } else if (formatValue(identifier, value) === undefined) {
          report(
            `${path}.${group}.${id}`,
            `expects a ${identifier.dataType} value, got ${JSON.stringify(value)}`,
          );
        }
        if (group === "captured" && id in element.match) {
          report(`${path}.captured.${id}`, "is also in match: keep it in one place");
        }
      }
    }
    const attributes = catalog.webIdentifiers.map((identifier): ResolvedAttribute => {
      const given = element.match[identifier.id] ?? captured[identifier.id];
      return {
        id: identifier.id,
        dataType: identifier.dataType,
        value:
          (given === undefined ? undefined : formatValue(identifier, given)) ??
          EMPTY_VALUES[identifier.dataType] ??
          "",
        inUse: identifier.id in element.match || dynamic.includes(identifier.id),
        dynamic: dynamic.includes(identifier.id),
        userVisible: identifier.userVisible,
      };
    });
    if (!resolved.has(element.key)) resolved.set(element.key, { spec: element, type, attributes });
  });
  return { declared, resolved };
}

/** Value as Blue Prism writes it, or `undefined` when it does not fit the data type. */
function formatValue(
  identifier: WebIdentifierInfo,
  value: string | number | boolean,
): string | undefined {
  switch (identifier.dataType) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
    case "flag":
      return typeof value === "boolean" ? (value ? "True" : "False") : undefined;
    case "text":
      return typeof value === "string" ? value : undefined;
    default:
      return String(value);
  }
}

function checkActionNames(spec: ObjectSpec, report: Report): void {
  const seen = new Set<string>();
  spec.actions.forEach((action, i) => {
    const path = `actions[${i}] "${action.name}".name`;
    if (action.name === INITIALISE_PAGE || action.name === CLEAN_UP_PAGE) {
      report(path, `"${action.name}" is a standard page of every object: choose another name`);
    } else if (seen.has(action.name)) {
      report(path, `duplicate action name "${action.name}"`);
    }
    seen.add(action.name);
  });
}

function resolveAction(
  spec: ObjectSpec,
  action: ActionSpec,
  path: string,
  applicationType: ElementTypeInfo | undefined,
  elements: Elements,
  report: Report,
): ResolvedAction {
  const items = new Map<string, Param>();
  const declare = (list: "inputs" | "outputs", params: ActionSpec["inputs"]): Param[] => {
    const seen = new Set<string>();
    return params.map((p, k) => {
      const param: Param = {
        name: p.name,
        dataType: p.type,
        narrative: p.description,
        initialValue: p.defaultValue === undefined ? undefined : literalValue(p.defaultValue),
      };
      if (
        p.defaultValue !== undefined &&
        typeof p.defaultValue !==
          (p.type === "number" ? "number" : p.type === "flag" ? "boolean" : "string")
      ) {
        report(`${path}.${list}[${k}].defaultValue`, `must be a ${p.type} literal`);
      }
      if (seen.has(p.name)) report(`${path}.${list}[${k}]`, `duplicate parameter "${p.name}"`);
      seen.add(p.name);
      const existing = items.get(p.name);
      if (!existing) items.set(p.name, param);
      else if (existing.dataType !== p.type) {
        report(
          `${path}.${list}[${k}]`,
          `"${p.name}" is also an input of type ${existing.dataType}: one data item, one type`,
        );
      }
      return param;
    });
  };
  const inputs = declare("inputs", action.inputs);
  const outputs = declare("outputs", action.outputs);

  const target = (name: string, dataType: string | undefined, stepPath: string, why: string) => {
    const existing = items.get(name);
    if (!existing) items.set(name, { name, dataType: dataType ?? "text" });
    else if (dataType !== undefined && existing.dataType !== dataType) {
      report(`${stepPath}.into`, `"${name}" is ${existing.dataType} but ${why} gives ${dataType}`);
    }
  };
  const element = (key: string, stepPath: string): ResolvedElement | undefined => {
    const found = elements.resolved.get(key);
    if (!found && !elements.declared.has(key)) {
      const keys = [...elements.declared].join(", ") || "none";
      report(`${stepPath}.element`, `element "${key}" is not declared (elements: ${keys})`);
    }
    return found;
  };
  const appOperation = (id: string, stepPath: string): OperationInfo | undefined => {
    const operation = applicationType?.actions.find((a) => a.id === id);
    if (applicationType && !operation) {
      report(stepPath, `the catalogue's Application type has no "${id}" action`);
    }
    return operation;
  };
  const argumentsFor = (
    op: OperationInfo | ConditionInfo,
    given: Readonly<Record<string, string>> | undefined,
    stepPath: string,
  ): Readonly<Record<string, string>> => {
    const args = given ?? {};
    for (const key of Object.keys(args)) {
      if (!op.arguments.some((a) => a.id === key))
        report(`${stepPath}.args.${key}`, `not an argument of ${op.id}`);
    }
    return args;
  };
  const parametersFor = (
    found: ResolvedElement,
    given: Readonly<Record<string, string>> | undefined,
    stepPath: string,
  ): Readonly<Record<string, string>> => {
    const params = given ?? {};
    const dynamic = found.spec.dynamic ?? [];
    for (const key of dynamic) {
      if (!params[key])
        report(
          `${stepPath}.params.${key}`,
          `missing runtime value for Dynamic attribute of ${found.spec.name}`,
        );
    }
    for (const key of Object.keys(params)) {
      if (!dynamic.includes(key))
        report(`${stepPath}.params.${key}`, `is not a Dynamic attribute of ${found.spec.name}`);
    }
    // Canonical ordering, independent of the order in which the agent wrote the params map.
    return Object.fromEntries(
      found.attributes.filter((a) => a.dynamic).map((a) => [a.id, params[a.id] ?? ""]),
    );
  };

  const steps: ResolvedStep[] = [];
  let raised = false;
  action.steps.forEach((step, j) => {
    const stepPath = `${path}.steps[${j}] (${step.kind})`;
    if (raised) report(stepPath, "unreachable: a raise step must be the last step of its action");
    switch (step.kind) {
      case "launch": {
        if (spec.application.kind !== "BrowserLaunch") {
          report(stepPath, `needs a BrowserLaunch application, not ${spec.application.kind}`);
        }
        const operation = appOperation("Launch", stepPath);
        const label = `Launch ${spec.application.name}`;
        if (operation)
          steps.push({
            kind: "navigate",
            label,
            element: undefined,
            operation,
            args: {},
            params: {},
          });
        break;
      }
      case "close": {
        const operation = appOperation("WebCloseApplication", stepPath);
        const label = `Close ${spec.application.name}`;
        if (operation)
          steps.push({
            kind: "navigate",
            label,
            element: undefined,
            operation,
            args: {},
            params: {},
          });
        break;
      }
      case "ensureAttached": {
        const attach = appOperation("AttachApplication", stepPath);
        const connectionRead =
          spec.application.kind === "BrowserAttach" ? "IsConnected" : "WebIsConnected";
        const read = applicationType?.readActions.find((op) => op.id === connectionRead);
        if (!read)
          report(
            stepPath,
            `the catalogue's ${spec.application.kind} Application type has no ${connectionRead} read; re-extract the catalogue`,
          );
        else if (read.returns !== "flag") report(stepPath, `${connectionRead} must return a flag`);
        let into = "Attached";
        for (let n = 2; items.has(into); n++) into = `Attached ${n}`;
        target(into, "flag", stepPath, connectionRead);
        if (attach && read)
          steps.push({
            kind: "ensureAttached",
            read,
            attach,
            into,
            args: argumentsFor(attach, step.args, stepPath),
          });
        break;
      }
      case "callPage": {
        const called = spec.actions.find((a) => a.name === step.page);
        if (!called) {
          report(`${stepPath}.page`, `unknown page "${step.page}"`);
          break;
        }
        const given = step.inputs ?? {};
        const mapped = step.outputs ?? {};
        for (const key of Object.keys(given)) {
          if (!called.inputs.some((p) => p.name === key))
            report(`${stepPath}.inputs.${key}`, `not an input of ${called.name}`);
        }
        const callInputs = called.inputs.map((p) => {
          const expression =
            given[p.name] ??
            (p.defaultValue === undefined ? undefined : literalExpression(p.defaultValue));
          if (expression === undefined)
            report(`${stepPath}.inputs`, `missing input "${p.name}" of ${called.name}`);
          return { name: p.name, dataType: p.type, expression: expression ?? "" };
        });
        const callOutputs = Object.entries(mapped).flatMap(([name, into]) => {
          const p = called.outputs.find((p) => p.name === name);
          if (!p) {
            report(`${stepPath}.outputs.${name}`, `not an output of ${called.name}`);
            return [];
          }
          target(into, p.type, stepPath, called.name);
          return [{ name, dataType: p.type, into }];
        });
        steps.push({
          kind: "callPage",
          page: called.name,
          inputs: callInputs,
          outputs: callOutputs,
        });
        break;
      }
      case "waitFor": {
        const found = element(step.element, stepPath);
        if (!found) break;
        const id = step.condition ?? DEFAULT_WAIT_CONDITION;
        const condition = found.type.conditions.find((c) => c.id === id);
        if (!condition) {
          report(
            `${stepPath}.condition`,
            `"${id}" is not a Wait condition of ${found.type.id} (conditions: ` +
              `${found.type.conditions.map((c) => c.id).join(", ")})`,
          );
        } else if (condition.dataType !== "flag" && step.expected === undefined) {
          report(
            `${stepPath}.condition`,
            `"${id}" yields ${condition.dataType}: provide the expected Blue Prism expression`,
          );
        } else {
          const { timeoutSeconds, onTimeout } = step;
          if (typeof timeoutSeconds === "string") {
            // Restrict dynamic timeouts to a declared numeric data item, not arbitrary untyped code.
            const ref = /^\[([^\]]+)\]$/.exec(timeoutSeconds)?.[1];
            if (!ref || items.get(ref)?.dataType !== "number") {
              report(
                `${stepPath}.timeoutSeconds`,
                "must be a positive number or a declared numeric data item, e.g. [Wait Timeout]",
              );
            }
          }
          steps.push({
            kind: "wait",
            label: step.name ?? `Wait for ${found.spec.name}`,
            element: found,
            condition,
            timeoutSeconds,
            onTimeout,
            expected: step.expected ?? "True",
            args: argumentsFor(condition, step.args, stepPath),
            params: parametersFor(found, step.params, stepPath),
          });
        }
        break;
      }
      case "write": {
        const found = element(step.element, stepPath);
        if (!found) break;
        const operation = found.type.writeAction;
        if (!operation) {
          report(`${stepPath}.element`, `${found.type.id} "${step.element}" cannot be written to`);
        } else {
          steps.push({
            kind: "write",
            label: step.name ?? `Write ${found.spec.name}`,
            element: found,
            operation,
            value: step.value,
            args: argumentsFor(operation, step.args, stepPath),
            params: parametersFor(found, step.params, stepPath),
          });
        }
        break;
      }
      case "read": {
        const found = element(step.element, stepPath);
        if (!found) break;
        const operation = found.type.readActions.find((r) => r.id === step.action);
        if (!operation) {
          report(`${stepPath}.action`, notAllowed(found.type, step.action, "read"));
          break;
        }
        target(step.into, operation.returns || undefined, stepPath, step.action);
        steps.push({
          kind: "read",
          label: step.name ?? `Read ${found.spec.name}`,
          element: found,
          operation,
          into: step.into,
          args: argumentsFor(operation, step.args, stepPath),
          params: parametersFor(found, step.params, stepPath),
        });
        break;
      }
      case "act": {
        const found = element(step.element, stepPath);
        if (!found) break;
        const operation = found.type.actions.find((a) => a.id === step.action);
        if (!operation) {
          report(`${stepPath}.action`, notAllowed(found.type, step.action, "act"));
          break;
        }
        const args = argumentsFor(operation, step.args, stepPath);
        const label = step.name ?? `${humanize(operation.id)} ${found.spec.name}`;
        steps.push({
          kind: "navigate",
          label,
          element: found,
          operation,
          args,
          params: parametersFor(found, step.params, stepPath),
        });
        break;
      }
      case "calc":
        target(step.into, undefined, stepPath, "the calculation");
        steps.push({ kind: "calc", expression: step.expression, into: step.into });
        break;
      case "raise":
        raised = true;
        steps.push({ kind: "raise", exception: step.exception });
        break;
    }
  });
  // Do not mistake [1] inside a quoted XPath literal for a Blue Prism data reference.
  action.steps.forEach((step, j) => {
    const expressions: string[] = [];
    if ("params" in step) expressions.push(...Object.values(step.params ?? {}));
    if ("args" in step) expressions.push(...Object.values(step.args ?? {}));
    if (step.kind === "waitFor" && step.expected !== undefined) expressions.push(step.expected);
    if (step.kind === "write") expressions.push(step.value);
    if (step.kind === "calc") expressions.push(step.expression);
    if (step.kind === "callPage") expressions.push(...Object.values(step.inputs ?? {}));
    for (const expression of expressions) {
      const unquoted = expression.replace(/"(?:[^"]|"")*"/g, "");
      for (const match of unquoted.matchAll(/\[([^\]]+)\]/g)) {
        const name = match[1] ?? "";
        if (!items.has(name)) report(`${path}.steps[${j}]`, `undeclared data item [${name}]`);
      }
    }
  });
  return { spec: action, inputs, outputs, dataItems: [...items.values()], steps };
}

function checkPageCycles(spec: ObjectSpec, report: Report): void {
  const pages = new Map(spec.actions.map((a) => [a.name, a]));
  const done = new Set<string>();
  const visit = (name: string, path: readonly string[]): void => {
    if (path.includes(name)) {
      report("actions", `recursive page call: ${[...path, name].join(" -> ")}`);
      return;
    }
    if (done.has(name)) return;
    for (const step of pages.get(name)?.steps ?? []) {
      if (step.kind === "callPage") visit(step.page, [...path, name]);
    }
    done.add(name);
  };
  for (const name of pages.keys()) visit(name, []);
}

export function literalValue(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "True" : "False") : String(value);
}

export function literalExpression(value: string | number | boolean): string {
  return typeof value === "string" ? textExpression(value) : literalValue(value);
}

/** Explains why an action id does not fit the step kind, pointing to the right kind if any. */
function notAllowed(type: ElementTypeInfo, id: string, kind: "read" | "act"): string {
  const hint =
    kind === "act" && type.readActions.some((r) => r.id === id)
      ? `; it is a read action: use a read step`
      : kind === "act" && type.writeAction?.id === id
        ? "; it is the write action: use a write step"
        : kind === "read" && type.actions.some((a) => a.id === id)
          ? "; it is an action: use an act step"
          : "";
  const allowed = (kind === "read" ? type.readActions : type.actions).map((o) => o.id).join(", ");
  const what = kind === "read" ? "read action" : "action";
  return `"${id}" is not an allowed ${what} of ${type.id}${hint} (allowed: ${allowed})`;
}

/** `WebSendKeys` → `Send Keys`. */
function humanize(operationId: string): string {
  return operationId.replace(/^Web/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}
