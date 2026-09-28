import sax from "sax";
import { BpXmlParseError } from "./errors.js";
import type { BpDocument, BpElement } from "./nodes.js";
import { isElementContent } from "./whitespace.js";

// sax (strict mode) keeps characters exactly as written: no end-of-line or attribute-value
// normalisation, like the .NET reader Blue Prism uses. `strictEntities` limits entities to
// the five XML ones (the typings do not declare the option).
const OPTIONS: sax.SAXOptions & { strictEntities: boolean } = {
  position: true,
  strictEntities: true,
  trim: false,
  normalize: false,
  xmlns: false,
};

/**
 * Parses a Blue Prism XML file (.bpprocess, .bpobject, .bprelease) into a lossless tree.
 *
 * Kept: element order, attribute order and values, text (verbatim, CR included), empty
 * `<x />` vs `<x></x>`, prefixes and `xmlns` attributes. Normalised: indentation between
 * elements, CDATA sections (become text). Rejected with {@link BpXmlParseError}: malformed
 * XML, DOCTYPE, comments and processing instructions (other than the XML declaration).
 */
export function parseBpXml(xml: string): BpDocument {
  const parser = sax.parser(true, OPTIONS);
  const stack: BpElement[] = [];
  let root: BpElement | undefined;
  let started = false;

  const fail = (message: string): never => {
    throw new BpXmlParseError(message, parser.line + 1, parser.column + 1);
  };
  const appendText = (value: string): void => {
    const parent = stack.at(-1);
    if (!parent) return; // whitespace around the root element
    const last = parent.children.at(-1);
    if (last?.kind === "text") last.value += value;
    else parent.children.push({ kind: "text", value });
  };

  parser.onerror = (error) => fail(error.message.split("\n")[0] ?? "Malformed XML");
  parser.onprocessinginstruction = ({ name }) => {
    if (name !== "xml" || started) fail(`Processing instruction <?${name}?> is not supported`);
    started = true;
  };
  parser.ondoctype = () => fail("DOCTYPE is not supported");
  parser.onsgmldeclaration = () => fail("SGML declarations are not supported");
  parser.oncomment = () => fail("Comments are not supported");
  parser.ontext = appendText;
  parser.oncdata = appendText;
  parser.onopentag = (tag) => {
    started = true;
    if (root) fail(`Unexpected element <${tag.name}> after the root element`);
    // With `xmlns: false`, sax gives plain tags: qualified names, string values.
    const { attributes: raw } = tag as sax.Tag;
    const attributes = Object.entries(raw).map(([name, value]) => ({ name, value }));
    const element: BpElement = {
      kind: "element",
      name: tag.name,
      attributes,
      children: [],
      selfClosing: tag.isSelfClosing,
    };
    stack.at(-1)?.children.push(element);
    stack.push(element);
  };
  parser.onclosetag = () => {
    const element = stack.pop();
    if (!element) return;
    if (isElementContent(element)) {
      element.children = element.children.filter((c) => c.kind === "element");
    }
    if (stack.length === 0) root = element;
  };

  parser.write(xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml).close(); // skip a BOM
  return { root: root ?? fail("No root element") };
}
