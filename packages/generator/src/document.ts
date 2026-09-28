import { doc, el, serializeBpXml, textEl, type BpDocument, type BpElement } from "@bpdev/model";

/** Blue Prism version written in `bpversion` (the version the format rules were proven on). */
export const BP_VERSION = "7.5.1.18099";

/** A generated Blue Prism file: the model document and its serialized XML. */
export interface GeneratedFile {
  /** Object or process name, as Blue Prism will show it. */
  readonly name: string;
  /** `<name>.bpobject` or `<name>.bpprocess`. */
  readonly fileName: string;
  readonly document: BpDocument;
  /** Deterministic UTF-8 XML, ready to write or import. */
  readonly xml: string;
}

export interface ProcessAttributes {
  readonly name: string;
  readonly narrative: string;
  readonly preferredId: string;
  /** Business objects only. */
  readonly object?: { readonly runMode: string };
}

/** `<process>` root with the header every Blue Prism process and object starts with. */
export function processElement(
  attributes: ProcessAttributes,
  children: readonly BpElement[],
): BpElement {
  return el(
    "process",
    {
      name: attributes.name,
      version: "1.0",
      bpversion: BP_VERSION,
      narrative: attributes.narrative,
      byrefcollection: "true",
      preferredid: attributes.preferredId,
      type: attributes.object && "object",
      runmode: attributes.object?.runMode,
    },
    [viewElement(), el("preconditions"), el("endpoint", { narrative: "" }), ...children],
  );
}

/** `<subsheet>` declaring a page; its stages follow it at the process level. */
export function subsheetElement(
  id: string,
  name: string,
  type: "Normal" | "CleanUp",
  published = true,
): BpElement {
  return el("subsheet", { subsheetid: id, type, published: published ? "True" : "False" }, [
    textEl("name", name),
    viewElement(),
  ]);
}

function viewElement(): BpElement {
  return el("view", {}, [
    textEl("camerax", "0"),
    textEl("cameray", "0"),
    textEl("zoom", "1.25", { version: "2" }),
  ]);
}

export function generatedFile(
  name: string,
  root: BpElement,
  extension: "bpobject" | "bpprocess",
): GeneratedFile {
  const document = doc(root);
  return { name, fileName: `${name}.${extension}`, document, xml: serializeBpXml(document) };
}
