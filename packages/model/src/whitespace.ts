import type { BpElement } from "./nodes.js";

const WHITESPACE_ONLY = /^[ \t\r\n]*$/;

/**
 * True when the element holds child elements and its text is only indentation. That text is
 * formatting, not data: the parser drops it and the serializer re-indents. Any other text
 * (leaf values, mixed content, whitespace inside a leaf) is data and kept verbatim.
 */
export function isElementContent(element: BpElement): boolean {
  let hasElement = false;
  for (const child of element.children) {
    if (child.kind === "element") hasElement = true;
    else if (!WHITESPACE_ONLY.test(child.value)) return false;
  }
  return hasElement;
}
