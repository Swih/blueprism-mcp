import type { Catalog } from "@bpdev/catalog";
import { el, textEl, type BpElement } from "@bpdev/model";
import { appDefinition } from "./appmodel.js";
import { generatedFile, processElement, subsheetElement, type GeneratedFile } from "./document.js";
import { GeneratorError } from "./errors.js";
import { IdRegistry } from "./ids.js";
import { parseObjectSpec, type ObjectSpec } from "./ir.js";
import { Page } from "./page.js";
import {
  CLEAN_UP_PAGE,
  INITIALISE_PAGE,
  resolveObject,
  type ResolvedAction,
  type ResolvedElement,
  type ResolvedStep,
} from "./resolve-object.js";
import {
  applicationStep,
  actionBody,
  calculationBody,
  dataItemBody,
  endBody,
  exceptionBody,
  objectCodeOptions,
  startBody,
  waitChoice,
} from "./stages.js";

export interface GenerateObjectOptions {
  /**
   * Chrome profile folder dedicated to the robot (docs/01-spikes.md rule 9). Replaces
   * `{robotProfileDir}` in the application spec, e.g. in `--user-data-dir={robotProfileDir}`.
   */
  readonly robotProfileDir?: string;
}

/**
 * Generates a Blue Prism 7.5.1 business object (`.bpobject`) from an ObjectSpec. Throws
 * `SpecValidationError` listing every problem when the spec is malformed or does not fit the
 * catalogue, and `DuplicateIdError` rather than writing two items with the same GUID.
 */
export function generateObject(
  spec: ObjectSpec,
  catalog: Catalog,
  options: GenerateObjectOptions = {},
): GeneratedFile {
  const plan = resolveObject(parseObjectSpec(spec), catalog, {
    robotProfileDir: options.robotProfileDir,
  });
  const owner = plan.spec.name;
  const ids = new IdRegistry();
  // Paths: object, object/page, object/page/type/name for stages. Application model items
  // use an empty page component, which no page can have: no collision by construction.
  const preferredId = ids.id(owner);
  const applicationId = ids.id(owner, "", "Application");
  const elementIds = new Map(
    plan.elements.map((e) => [e.spec.key, ids.id(owner, "", "Element", e.spec.key)]),
  );
  const elementId = (key: string): string => {
    const id = elementIds.get(key);
    if (id === undefined) throw new GeneratorError(`Internal error: element "${key}" has no id`);
    return id;
  };
  const target = (key: string | undefined): string =>
    key === undefined ? applicationId : elementId(key);

  const children: BpElement[] = [
    appDefinition(plan, applicationId, elementId),
    ...initialisePage(ids, owner),
    ...cleanUpPage(ids, owner),
    ...plan.actions.flatMap((action) => actionPage(ids, owner, action, target)),
  ];
  const root = processElement(
    {
      name: owner,
      narrative: plan.spec.description,
      preferredId,
      object: { runMode: plan.spec.runMode },
    },
    children,
  );
  return generatedFile(owner, root, "bpobject");
}

/** Main page, shown as "Initialise" in Object Studio: ProcessInfo with code options (G7). */
function initialisePage(ids: IdRegistry, owner: string): BpElement[] {
  const page = new Page(ids, owner, INITIALISE_PAGE, undefined);
  page.info("ProcessInfo", "Info", "", objectCodeOptions());
  page.main("Start", "Start", []);
  page.main("End", "End", []);
  return page.stages;
}

function cleanUpPage(ids: IdRegistry, owner: string): BpElement[] {
  const subsheetId = ids.id(owner, CLEAN_UP_PAGE);
  const page = new Page(ids, owner, CLEAN_UP_PAGE, subsheetId);
  page.info("SubSheetInfo", CLEAN_UP_PAGE, "", []);
  page.main("Start", "Start", []);
  page.main("End", "End", []);
  return [subsheetElement(subsheetId, CLEAN_UP_PAGE, "CleanUp"), ...page.stages];
}

function actionPage(
  ids: IdRegistry,
  owner: string,
  action: ResolvedAction,
  target: (key: string | undefined) => string,
): BpElement[] {
  const name = action.spec.name;
  const subsheetId = ids.id(owner, name);
  const page = new Page(ids, owner, name, subsheetId);
  page.info("SubSheetInfo", name, action.spec.description, []);
  page.main("Start", "Start", startBody(action.inputs));
  for (const step of action.steps) addStep(ids, owner, page, step, target);
  page.main("End", "End", endBody(action.outputs));
  for (const item of action.dataItems) {
    page.data(item.name, dataItemBody(item.dataType, item.initialValue), item.narrative);
  }
  return [
    subsheetElement(subsheetId, name, "Normal", action.spec.published ?? true),
    ...page.stages,
  ];
}

function addStep(
  ids: IdRegistry,
  owner: string,
  page: Page,
  step: ResolvedStep,
  target: (key: string | undefined) => string,
): void {
  switch (step.kind) {
    case "navigate":
      page.main("Navigate", step.label, [
        applicationStep(
          target(step.element?.spec.key),
          step.operation,
          step.args,
          {},
          step.params,
          parameterTypes(step.element),
        ),
      ]);
      return;
    case "write":
      page.main("Write", step.label, [
        applicationStep(
          target(step.element.spec.key),
          step.operation,
          step.args,
          { expr: step.value },
          step.params,
          parameterTypes(step.element),
        ),
      ]);
      return;
    case "read":
      page.main("Read", step.label, [
        applicationStep(
          target(step.element.spec.key),
          step.operation,
          step.args,
          { stage: step.into },
          step.params,
          parameterTypes(step.element),
        ),
      ]);
      return;
    case "calc":
      page.main("Calculation", `Set ${step.into}`, calculationBody(step.expression, step.into));
      return;
    case "raise":
      page.main(
        "Exception",
        `Raise ${step.exception.type}`,
        exceptionBody(step.exception.type, step.exception.detail, step.exception.saveScreenCapture),
      );
      page.endFlow();
      return;
    case "wait":
      addWait(ids, owner, page, step, target(step.element.spec.key));
      return;
    case "callPage": {
      // Page GUIDs are deterministic; references do not claim a second declaration in IdRegistry.
      const body = actionBody(owner, step.page, step.inputs, step.outputs).filter(
        (node) => node.name !== "resource",
      );
      page.main("SubSheet", step.page, [
        ...body,
        textEl("processid", pageReference(owner, step.page)),
      ]);
      return;
    }
    case "ensureAttached": {
      page.main("Read", "Read Connection", [
        applicationStep(target(undefined), step.read, {}, { stage: step.into }),
      ]);
      const decision = page.main("Decision", "Already Attached?", [
        el("decision", { expression: `[${step.into}]` }),
      ]);
      const attach = page.branch(
        "Navigate",
        "Attach Application",
        [applicationStep(target(undefined), step.attach, step.args)],
        decision.position.y,
      );
      decision.element.children.push(textEl("onfalse", attach.id));
      page.continueFrom(decision.element, "ontrue");
      const joined = page.main("Anchor", "Attached", []);
      Page.link(attach, joined);
      return;
    }
  }
}

/**
 * G10: WaitStart with one choice (the condition, expected True) continuing the main flow;
 * on timeout, WaitEnd then an Exception stage with the given type and detail, to the right.
 */
function addWait(
  ids: IdRegistry,
  owner: string,
  page: Page,
  step: Extract<ResolvedStep, { kind: "wait" }>,
  elementId: string,
): void {
  const choice = waitChoice(
    "Condition met",
    elementId,
    step.condition,
    step.expected,
    step.args,
    step.params,
    parameterTypes(step.element),
  );
  let groupId = "";
  const wait = page.main("WaitStart", step.label, (name) => {
    groupId = ids.id(owner, page.name, "WaitGroup", name);
    return [
      textEl("groupid", groupId),
      el("choices", {}, [choice]),
      textEl("timeout", String(step.timeoutSeconds)),
    ];
  });
  const timeout = page.branch("WaitEnd", "Time Out", [textEl("groupid", groupId)], wait.position.y);
  // BP 7.5.1 clamps a Wait choice's distance while loading WaitStart. Its WaitEnd must
  // already exist, otherwise the maximum distance is zero and the condition is hidden.
  page.serializeBefore(timeout, wait);
  const exception = page.branch(
    "Exception",
    step.onTimeout.type,
    exceptionBody(step.onTimeout.type, step.onTimeout.detail, step.onTimeout.saveScreenCapture),
  );
  Page.link(timeout, exception);
  page.continueFrom(choice, "ontrue");
}

function parameterTypes(element: ResolvedElement | undefined): Readonly<Record<string, string>> {
  return Object.fromEntries(
    (element?.attributes ?? []).filter((a) => a.dynamic).map((a) => [a.id, a.dataType]),
  );
}

function pageReference(owner: string, page: string): string {
  return new IdRegistry().id(owner, page);
}
