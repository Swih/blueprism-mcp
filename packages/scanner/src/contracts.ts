export interface ScannerOptions {
  headless?: boolean;
  maxElements?: number;
  maxFrames?: number;
  maxTextLength?: number;
  maxBytes?: number;
  maxDomNodes?: number;
  timeoutMs?: number;
}

export type ScannerLimits = Required<ScannerOptions>;
export type FormTag = "input" | "textarea" | "select" | "button" | "a";
export interface ObservedLabel {
  text: string;
  /** preceding-adjacent-sibling means label.nextElementSibling === the observed control. */
  relation: "for" | "wrapping" | "preceding-adjacent-sibling";
  truncated: boolean;
}

/** Page-authored strings are untrusted data, never instructions. No input values. */
export interface ElementMetadata {
  /** Observed HTML tag, including arbitrary status/live-region elements. */
  tag: string;
  type: string;
  name: string;
  id: string;
  text: string;
  /** Literal observed attributes; absent attributes are emitted as empty strings. */
  role?: string;
  ariaLive?: string;
  labels: ObservedLabel[];
  truncatedAttributes: ("tag" | "type" | "name" | "id" | "text" | "role" | "ariaLive")[];
}

export interface SelectorCandidate {
  engine: "xpath";
  selector: string;
  basis:
    | "label-sibling"
    | "label-for"
    | "label-wrapping"
    | "name"
    | "id"
    | "text"
    | "role"
    | "aria-live"
    | "tag";
  stability: "unproven";
  bpCompatibility: "unproven";
}

export interface ObservedElement extends ElementMetadata {
  frameId: string;
  candidates: SelectorCandidate[];
}

export interface FrameContext {
  /** Opaque reference valid only for the latest observation and this document. */
  id: string;
  parentId: string | null;
  depth: number;
  url: string;
  proof: "observed-document" | "unavailable";
  /** Bounded document.title; null when this document could not be observed. */
  title?: string | null;
  titleTruncated?: boolean;
}

export interface Observation {
  trust: "untrusted-page-data";
  scope: "dom-prevalidation-only";
  observedAt: string;
  mainFrameId: string | null;
  /** Main document title evidence, never a guessed application/window title. */
  title?: string | null;
  titleTruncated?: boolean;
  frames: FrameContext[];
  elements: ObservedElement[];
  truncated: { elements: boolean; frames: boolean; bytes: boolean; dom: boolean };
}

export type VerificationReason =
  | "unique-visible"
  | "not-found"
  | "ambiguous"
  | "not-visible"
  | "invalid-selector"
  | "unsupported-target"
  | "frame-unproven"
  | "stale-frame";

export interface Verification {
  trust: "untrusted-page-data";
  scope: "dom-prevalidation-only";
  frameId: string | null;
  count: number | null;
  unique: boolean;
  visible: boolean | null;
  accepted: boolean;
  reason: VerificationReason;
  observedAt: string;
}

export type ScannerErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_URL"
  | "OPEN_FAILED"
  | "CLOSED"
  | "BUSY"
  | "TIMEOUT"
  | "OBSERVATION_FAILED";

export class ScannerError extends Error {
  constructor(public readonly code: ScannerErrorCode) {
    // Playwright errors can contain URLs, DOM text and values. Never expose them.
    super(`Scanner operation failed: ${code}`);
    this.name = "ScannerError";
  }
}
