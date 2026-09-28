import type { BpElement } from "./nodes.js";

/** `bpr:release` → `release`. */
export function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

export function getAttr(element: BpElement, name: string): string | undefined {
  return element.attributes.find((a) => a.name === name)?.value;
}

/** Replaces the value in place (keeping attribute order) or appends the attribute. */
export function setAttr(element: BpElement, name: string, value: string): void {
  const existing = element.attributes.find((a) => a.name === name);
  if (existing) existing.value = value;
  else element.attributes.push({ name, value });
}

/** Element children, optionally only those with the given (exact) name. */
export function childElements(element: BpElement, name?: string): BpElement[] {
  return element.children.filter(
    (c): c is BpElement => c.kind === "element" && (name === undefined || c.name === name),
  );
}

export function firstChild(element: BpElement, name: string): BpElement | undefined {
  return childElements(element, name)[0];
}

/** Concatenated text children of the element (not of its descendants). */
export function textContent(element: BpElement): string {
  return element.children.map((c) => (c.kind === "text" ? c.value : "")).join("");
}

/** Text of the first child with that name, or `undefined` when there is no such child. */
export function childText(element: BpElement, name: string): string | undefined {
  const child = firstChild(element, name);
  return child && textContent(child);
}
