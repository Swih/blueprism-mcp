/**
 * The document tree. Plain mutable data: names are kept exactly as written (prefix included,
 * e.g. `bpr:release`), and `xmlns` declarations are ordinary attributes, so namespaces
 * round-trip untouched.
 */

export interface BpAttribute {
  name: string;
  value: string;
}

export interface BpText {
  kind: "text";
  value: string;
}

export interface BpElement {
  kind: "element";
  name: string;
  /** In document order. */
  attributes: BpAttribute[];
  children: BpNode[];
  /** Written as `<x />` rather than `<x></x>` when it has no children. */
  selfClosing: boolean;
}

export type BpNode = BpElement | BpText;

export interface BpDocument {
  root: BpElement;
}
