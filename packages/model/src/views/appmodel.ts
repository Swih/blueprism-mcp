import type { BpElement } from "../nodes.js";
import { childElements, childText, firstChild, getAttr } from "../query.js";
import { requireAttr, requireChildText, requireName } from "./require.js";

/** An element of an object's application model (`<appdef>`), the root application included. */
export interface AppElementView {
  id: string;
  name: string;
  /** `Application`, `WebButton`… as written. */
  type: string | undefined;
  /** Id of the parent element, `undefined` for the root application element. */
  parentId: string | undefined;
  attributes: AppAttributeView[];
  element: BpElement;
}

/** A match attribute (`<attribute>`) with its `<ProcessValue>`. */
export interface AppAttributeView {
  name: string;
  /** Used for matching (`inuse="True"`). */
  inUse: boolean;
  datatype: string | undefined;
  value: string | undefined;
}

/** Application model elements in document order (depth first). Empty for a process. */
export function listAppElements(root: BpElement): AppElementView[] {
  requireName(root, "process");
  const appdef = firstChild(root, "appdef");
  const result: AppElementView[] = [];
  const visit = (element: BpElement, parentId: string | undefined): void => {
    const id = requireChildText(element, "id");
    result.push({
      id,
      name: requireAttr(element, "name"),
      type: childText(element, "type"),
      parentId,
      attributes: readAttributes(element),
      element,
    });
    for (const child of childElements(element, "element")) visit(child, id);
  };
  for (const element of appdef ? childElements(appdef, "element") : []) visit(element, undefined);
  return result;
}

function readAttributes(element: BpElement): AppAttributeView[] {
  const attributes = firstChild(element, "attributes");
  if (!attributes) return [];
  return childElements(attributes, "attribute").map((attribute) => {
    const value = firstChild(attribute, "ProcessValue");
    return {
      name: requireAttr(attribute, "name"),
      inUse: getAttr(attribute, "inuse")?.toLowerCase() === "true",
      datatype: value && getAttr(value, "datatype"),
      value: value && getAttr(value, "value"),
    };
  });
}
