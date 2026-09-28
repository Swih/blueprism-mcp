import type { BpElement } from "../nodes.js";
import { childElements, childText, getAttr } from "../query.js";
import { requireAttr, requireChildText, requireName } from "./require.js";

/** Root attributes of a process or business object (`<process>`, `type="object"` for objects). */
export interface ProcessHeader {
  name: string;
  type: "process" | "object";
  bpversion: string | undefined;
  runmode: string | undefined;
  preferredid: string | undefined;
}

/** A page other than the main page (`<subsheet>`). */
export interface PageView {
  id: string;
  name: string;
  /** `Normal`, `CleanUp`… as written. */
  type: string | undefined;
  element: BpElement;
}

export interface StageView {
  id: string;
  name: string;
  /** `Start`, `Action`, `Decision`… as written. */
  type: string;
  /** Owning page, `undefined` for the main page. */
  pageId: string | undefined;
  /** Direct links of the stage (links held by wait choices are not included). */
  onSuccess: string | undefined;
  onTrue: string | undefined;
  onFalse: string | undefined;
  element: BpElement;
}

export function readProcessHeader(root: BpElement): ProcessHeader {
  requireName(root, "process");
  return {
    name: requireAttr(root, "name"),
    type: getAttr(root, "type") === "object" ? "object" : "process",
    bpversion: getAttr(root, "bpversion"),
    runmode: getAttr(root, "runmode"),
    preferredid: getAttr(root, "preferredid"),
  };
}

export function listPages(root: BpElement): PageView[] {
  requireName(root, "process");
  return childElements(root, "subsheet").map((element) => ({
    id: requireAttr(element, "subsheetid"),
    name: requireChildText(element, "name"),
    type: getAttr(element, "type"),
    element,
  }));
}

export function listStages(root: BpElement): StageView[] {
  requireName(root, "process");
  return childElements(root, "stage").map((element) => ({
    id: requireAttr(element, "stageid"),
    name: requireAttr(element, "name"),
    type: requireAttr(element, "type"),
    pageId: childText(element, "subsheetid"),
    onSuccess: childText(element, "onsuccess"),
    onTrue: childText(element, "ontrue"),
    onFalse: childText(element, "onfalse"),
    element,
  }));
}
