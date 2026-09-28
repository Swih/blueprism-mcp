import type { BpDocument, BpElement } from "./nodes.js";
import { isElementContent } from "./whitespace.js";

/**
 * A plain-text dump of the tree, one node per line, for comparing two trees in tests.
 * It is independent of the serializer on purpose. Compared: element names, attributes in
 * order with their values, text verbatim. Ignored: indentation between elements, and the
 * `<x />` vs `<x></x>` spelling.
 */
export function canonicalize(node: BpDocument | BpElement): string {
  const lines: string[] = [];
  dump("root" in node ? node.root : node, "", lines);
  return lines.join("\n");
}

function dump(element: BpElement, indent: string, lines: string[]): void {
  const attributes = element.attributes.map((a) => ` @${a.name}=${JSON.stringify(a.value)}`);
  lines.push(`${indent}${element.name}${attributes.join("")}`);
  const skipText = isElementContent(element);
  let text = ""; // adjacent text nodes compare as one; empty text as none
  const flushText = (): void => {
    if (text) lines.push(`${indent}  ${JSON.stringify(text)}`);
    text = "";
  };
  for (const child of element.children) {
    if (child.kind === "element") {
      flushText();
      dump(child, `${indent}  `, lines);
    } else if (!skipText) {
      text += child.value;
    }
  }
  flushText();
}
