import { BpViewError } from "../errors.js";
import type { BpElement } from "../nodes.js";
import { childText, getAttr } from "../query.js";

export function requireAttr(element: BpElement, name: string): string {
  const value = getAttr(element, name);
  if (value === undefined) throw new BpViewError(`<${element.name}> has no ${name} attribute`);
  return value;
}

export function requireChildText(element: BpElement, name: string): string {
  const value = childText(element, name);
  if (value === undefined) throw new BpViewError(`<${element.name}> has no <${name}> child`);
  return value;
}

export function requireName(element: BpElement, name: string): void {
  if (element.name !== name) {
    throw new BpViewError(`Expected a <${name}> element, got <${element.name}>`);
  }
}
