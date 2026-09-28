import { BpXmlSerializeError } from "./errors.js";
import type { BpDocument, BpElement, BpNode } from "./nodes.js";
import { isElementContent } from "./whitespace.js";

const DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';
const INDENT = "  ";
// Close to the XML Name production; enough to refuse names that would break the output.
const NAME = /^[\p{L}_][\p{L}\p{N}_.:-]*$/u;
// Characters XML 1.0 cannot carry at all, even as character references.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/u;

/**
 * Writes the tree as deterministic UTF-8 XML text (no BOM): XML declaration, two-space
 * indentation, LF line endings, `<x />` for empty self-closing elements. Elements that hold
 * text are written inline so that no whitespace is added to data.
 *
 * Escaping follows the .NET writer Blue Prism uses (`&amp; &lt; &gt;`, plus `&quot;` in
 * attributes); CR, LF and TAB inside attribute values, and CR inside text, are written as
 * character references so any reader gets them back exactly.
 */
export function serializeBpXml(doc: BpDocument): string {
  const out: string[] = [DECLARATION, "\n"];
  writeIndented(doc.root, 0, out);
  out.push("\n");
  return out.join("");
}

function writeIndented(element: BpElement, depth: number, out: string[]): void {
  const indent = INDENT.repeat(depth);
  if (!isElementContent(element)) {
    out.push(indent);
    writeInline(element, out);
    return;
  }
  out.push(indent, openTag(element), ">\n");
  for (const child of element.children) {
    if (child.kind !== "element") continue; // indentation only (see isElementContent)
    writeIndented(child, depth + 1, out);
    out.push("\n");
  }
  out.push(indent, "</", element.name, ">");
}

function writeInline(node: BpNode, out: string[]): void {
  if (node.kind === "text") {
    out.push(escapeText(node.value));
    return;
  }
  if (node.children.length === 0) {
    out.push(openTag(node), node.selfClosing ? " />" : `></${node.name}>`);
    return;
  }
  out.push(openTag(node), ">");
  for (const child of node.children) writeInline(child, out);
  out.push("</", node.name, ">");
}

function openTag(element: BpElement): string {
  checkName(element.name);
  let tag = `<${element.name}`;
  for (const { name, value } of element.attributes) {
    checkName(name);
    tag += ` ${name}="${escapeAttribute(value)}"`;
  }
  return tag;
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new BpXmlSerializeError(`Invalid XML name: ${JSON.stringify(name)}`);
}

function checkChars(value: string): void {
  const match = FORBIDDEN.exec(value);
  if (match) {
    const code = match[0].codePointAt(0) ?? 0;
    throw new BpXmlSerializeError(
      `Character U+${code.toString(16).padStart(4, "0")} cannot be written in XML`,
    );
  }
}

function escapeText(value: string): string {
  checkChars(value);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#xD;");
}

function escapeAttribute(value: string): string {
  checkChars(value);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r", "&#xD;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\t", "&#x9;");
}
