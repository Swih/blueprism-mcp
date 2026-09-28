import type { BpDocument, BpElement, BpNode, BpText } from "./nodes.js";

/** Attributes in the order they will be written; `undefined` values are left out. */
export type BpAttrs = Readonly<Record<string, string | undefined>>;
/** A child node, or a string for a text node (an empty string adds nothing). */
export type BpChild = BpNode | string;

/** Creates an element. Without children it is written `<name />`, as Blue Prism does. */
export function el(
  name: string,
  attrs: BpAttrs = {},
  children: readonly BpChild[] = [],
): BpElement {
  return {
    kind: "element",
    name,
    attributes: Object.entries(attrs).flatMap(([n, value]) =>
      value === undefined ? [] : [{ name: n, value }],
    ),
    children: children.flatMap((c) => (typeof c !== "string" ? [c] : c === "" ? [] : [text(c)])),
    selfClosing: true,
  };
}

export function text(value: string): BpText {
  return { kind: "text", value };
}

/** `<name attrs>value</name>`, the common Blue Prism leaf (`<id>…</id>`, `<type>…</type>`). */
export function textEl(name: string, value: string, attrs: BpAttrs = {}): BpElement {
  return el(name, attrs, [value]);
}

export function doc(root: BpElement): BpDocument {
  return { root };
}
