import { el, textEl, type BpElement } from "@bpdev/model";
import type { IdRegistry } from "./ids.js";
import { Page, type Stage } from "./page.js";
import { dataItemBody, stageElement, type Param } from "./stages.js";

export const CASE_FIELD: Param = { name: "CaseKey", dataType: "text" };
/** Serialized native object identifier; "Work Queues" is only its Studio display name. */
export const WORK_QUEUES_OBJECT = "Blueprism.Automate.clsWorkQueuesActions";
/** Native Collections IBO identifier, inspected alongside its Count Rows signature. */
export const COLLECTIONS_OBJECT = "Blueprism.AutomateProcessCore.clsCollectionActions";

/** Shape evidenced by the native collection loader (not a scalar Data stage). */
export function queueCollectionBody(
  fields: readonly Param[],
  rows: readonly Readonly<Record<string, string>>[] = [],
): BpElement[] {
  return [
    textEl("datatype", "collection"),
    el("private"),
    el("alwaysinit"),
    el(
      "collectioninfo",
      {},
      fields.map((field) => el("field", { name: field.name, type: field.dataType })),
    ),
    el(
      "initialvalue",
      {},
      rows.map((row) =>
        el(
          "row",
          {},
          fields.map((field) =>
            el("field", {
              name: field.name,
              type: field.dataType,
              value: row[field.name] ?? "",
            }),
          ),
        ),
      ),
    ),
  ];
}

export function addQueueCollection(
  page: Page,
  ids: IdRegistry,
  owner: string,
  name: string,
  fields: readonly Param[],
  rows: readonly Readonly<Record<string, string>>[] = [],
  y = 450,
): void {
  page.stages.push(
    stageElement(
      {
        id: ids.id(owner, page.name, "Collection", name),
        name,
        type: "Collection",
        subsheetId: page.subsheetId,
        position: { x: 480, y, w: 180, h: 90 },
      },
      queueCollectionBody(fields, rows),
    ),
  );
}

export function addQueueData(
  page: Page,
  params: readonly (Param & { readonly value?: string })[],
): void {
  for (const param of params)
    page.data(param.name, dataItemBody(param.dataType, param.value ?? ""));
}

export function queueDecision(page: Page, name: string, expression: string): Stage {
  const stage = page.main("Decision", name, [el("decision", { expression })]);
  page.endFlow();
  return stage;
}

export function queueLinkDecision(from: Stage, when: "ontrue" | "onfalse", to: Stage): void {
  from.element.children.push(textEl(when, to.id));
}
