/**
 * Builders for the XML of Blue Prism stages, as proven on 7.5.1 (docs/01-spikes.md and
 * spikes/s2s3_rpachallenge.py). Pure functions: ids, links and positions come from Page.
 */
import type { ArgumentInfo, ConditionInfo, OperationInfo } from "@bpdev/catalog";
import { el, textEl, type BpChild, type BpElement } from "@bpdev/model";
import { WAIT_CHOICE_DISTANCE, type Position } from "./layout.js";

export interface StageHead {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Owning page; `undefined` on the main page. */
  readonly subsheetId: string | undefined;
  readonly position: Position;
  readonly narrative?: string | undefined;
}

/** A page parameter or data item: name and Blue Prism data type. */
export interface Param {
  readonly name: string;
  readonly dataType: string;
  readonly narrative?: string | undefined;
  readonly initialValue?: string | undefined;
}

/** `<stage>` with the common head (subsheetid, narrative, display), then `body`. */
export function stageElement(head: StageHead, body: readonly BpChild[]): BpElement {
  const { x, y, w, h } = head.position;
  return el("stage", { stageid: head.id, name: head.name, type: head.type }, [
    head.subsheetId === undefined ? "" : textEl("subsheetid", head.subsheetId),
    head.narrative ? textEl("narrative", head.narrative) : "",
    el("display", {
      x: String(x),
      y: String(y),
      w: w === undefined ? undefined : String(w),
      h: h === undefined ? undefined : String(h),
    }),
    ...body,
  ]);
}

/**
 * Code options of an object's ProcessInfo stage. Without them the engine throws a
 * NullReferenceException when the object starts (docs/01-spikes.md rule 6).
 */
export function objectCodeOptions(): BpElement[] {
  const references = ["System.dll", "System.Data.dll", "System.Xml.dll", "System.Drawing.dll"];
  const imports = ["System", "System.Drawing", "System.Data"];
  return [
    el(
      "references",
      {},
      references.map((r) => textEl("reference", r)),
    ),
    el(
      "imports",
      {},
      imports.map((i) => textEl("import", i)),
    ),
    textEl("language", "visualbasic"),
    el("pythondllpath"),
    el("pythonenvpath"),
    el("globalcode"),
    el("code"),
  ];
}

/** Start stage body: the page inputs, each bound to the data item of the same name. */
export function startBody(inputs: readonly Param[]): BpChild[] {
  return parameterList("inputs", "input", inputs);
}

/** End stage body: the page outputs, each read from the data item of the same name. */
export function endBody(outputs: readonly Param[]): BpChild[] {
  return parameterList("outputs", "output", outputs);
}

function parameterList(list: string, item: string, params: readonly Param[]): BpChild[] {
  if (params.length === 0) return [];
  return [
    el(
      list,
      {},
      params.map((p) =>
        el(item, {
          type: p.dataType,
          name: p.name,
          narrative: p.narrative || undefined,
          stage: p.name,
        }),
      ),
    ),
  ];
}

/** Data item private to its page, reset each time the page runs. */
export function dataItemBody(dataType: string, initialValue = ""): BpElement[] {
  return [
    textEl("datatype", dataType),
    textEl("initialvalue", initialValue),
    el("private"),
    el("alwaysinit"),
  ];
}

/**
 * `<step>` of a Navigate, Read or Write stage. Every argument the catalogue declares is
 * written, empty when not given (= Application Modeller default); leaving one out makes the
 * engine throw at run time (docs/01-spikes.md rule 3, G4). Declared outputs are written too.
 */
export function applicationStep(
  elementId: string,
  operation: OperationInfo,
  values: Readonly<Record<string, string>> = {},
  stepAttributes: Readonly<Record<string, string>> = {},
  parameters: Readonly<Record<string, string>> = {},
  parameterTypes: Readonly<Record<string, string>> = {},
): BpElement {
  return el("step", stepAttributes, [
    elementReference(elementId, parameters, parameterTypes),
    el("action", {}, [
      textEl("id", operation.id),
      argumentList(operation.arguments, values),
      operation.outputs.length === 0
        ? ""
        : el(
            "outputs",
            {},
            operation.outputs.map((o) =>
              el("output", {}, [textEl("id", o.id), textEl("value", "")]),
            ),
          ),
    ]),
  ]);
}

/** A Wait choice compares against a normalized BP expression; the page adds `ontrue`. */
export function waitChoice(
  name: string,
  elementId: string,
  condition: ConditionInfo,
  expected = "True",
  args: Readonly<Record<string, string>> = {},
  parameters: Readonly<Record<string, string>> = {},
  parameterTypes: Readonly<Record<string, string>> = {},
): BpElement {
  return el("choice", { expression: expected }, [
    textEl("name", name),
    textEl("distance", String(WAIT_CHOICE_DISTANCE)),
    elementReference(elementId, parameters, parameterTypes),
    el("condition", {}, [textEl("id", condition.id), argumentList(condition.arguments, args)]),
    textEl("comparetype", "Equal"),
  ]);
}

/** Dynamic attributes are children of the element reference, never action arguments. */
function elementReference(
  id: string,
  parameters: Readonly<Record<string, string>>,
  types: Readonly<Record<string, string>>,
): BpElement {
  return el(
    "element",
    { id },
    Object.entries(parameters).map(([name, expression]) =>
      el("elementparameter", {}, [
        textEl("name", name),
        textEl("expression", expression),
        textEl("datatype", types[name] ?? "text"),
        textEl("comparisontype", "Equal"),
      ]),
    ),
  );
}

function argumentList(
  args: readonly ArgumentInfo[],
  values: Readonly<Record<string, string>>,
): BpElement {
  return el(
    "arguments",
    {},
    args.map((a) => el("argument", {}, [textEl("id", a.id), textEl("value", values[a.id] ?? "")])),
  );
}

/** Blue Prism string literal for a plain text (`"` doubled). */
export function textExpression(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Exception stage body raising `type` with a plain-text `detail`. */
export function exceptionBody(
  type: string,
  detail: string,
  saveScreenCapture = false,
): BpElement[] {
  // BP enables capture by attribute presence, even savescreencapture="no". False must omit it.
  return [
    el("exception", {
      localized: "yes",
      type,
      detail: textExpression(detail),
      savescreencapture: saveScreenCapture ? "yes" : undefined,
    }),
  ];
}

/** Exception stage body rethrowing the current exception (end of a Recover block). */
export function rethrowBody(): BpElement[] {
  return [el("exception", { localized: "yes", type: "", detail: "", usecurrent: "yes" })];
}

export function calculationBody(expression: string, into: string): BpElement[] {
  return [el("calculation", { expression, stage: into })];
}

/**
 * Action stage body calling a page of a business object. `friendlyname` is mandatory on the
 * parameters, or the engine looks them up in the object catalogue and throws (rule 5, G8).
 */
export function actionBody(
  object: string,
  action: string,
  inputs: readonly (Param & { readonly expression: string })[],
  outputs: readonly (Param & { readonly into: string })[],
): BpElement[] {
  return [
    ...(inputs.length === 0
      ? []
      : [
          el(
            "inputs",
            {},
            inputs.map((i) =>
              el("input", {
                type: i.dataType,
                name: i.name,
                friendlyname: i.name,
                expr: i.expression,
              }),
            ),
          ),
        ]),
    ...(outputs.length === 0
      ? []
      : [
          el(
            "outputs",
            {},
            outputs.map((o) =>
              el("output", { type: o.dataType, name: o.name, friendlyname: o.name, stage: o.into }),
            ),
          ),
        ]),
    el("resource", { object, action }),
  ];
}
