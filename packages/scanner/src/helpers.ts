import { ScannerError } from "./contracts.js";
import type {
  ElementMetadata,
  Observation,
  ScannerLimits,
  ScannerOptions,
  SelectorCandidate,
} from "./contracts.js";

export function resolveOptions(options: ScannerOptions = {}): ScannerLimits {
  const number = (
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max)
      throw new ScannerError("INVALID_OPTIONS");
    return result;
  };
  if (options.headless !== undefined && typeof options.headless !== "boolean")
    throw new ScannerError("INVALID_OPTIONS");
  return {
    headless: options.headless ?? true,
    maxElements: number(options.maxElements, 100, 1, 500),
    maxFrames: number(options.maxFrames, 10, 1, 32),
    maxTextLength: number(options.maxTextLength, 160, 1, 500),
    maxBytes: number(options.maxBytes, 65536, 2048, 262144),
    maxDomNodes: number(options.maxDomNodes, 10000, 1, 50000),
    timeoutMs: number(options.timeoutMs, 10000, 100, 30000),
  };
}

export function validateUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
    return url.href;
  } catch {
    throw new ScannerError("INVALID_URL");
  }
}

export function safeFrameUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "about:" && ["blank", "srcdoc"].includes(url.pathname))
      return `about:${url.pathname}`;
    if (!["http:", "https:"].includes(url.protocol)) return "[unsupported-url]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 1024);
  } catch {
    return "[unsupported-url]";
  }
}

export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(', "\'", ')})`;
}

export function selectorCandidates(element: ElementMetadata): SelectorCandidate[] {
  const candidates: SelectorCandidate[] = [];
  // Arbitrary HTML tag names must not become XPath syntax or truncated exact matches.
  if (element.truncatedAttributes.includes("tag") || !/^[a-z][a-z0-9-]*$/.test(element.tag))
    return candidates;
  const add = (basis: SelectorCandidate["basis"], selector: string): void => {
    if (selector.length <= 2048 && !candidates.some((c) => c.selector === selector)) {
      candidates.push({
        engine: "xpath",
        selector,
        basis,
        stability: "unproven",
        bpCompatibility: "unproven",
      });
    }
  };
  // At most one observed adjacent label plus two HTML-associated labels.
  const labels = element.labels.slice(0, 3);
  for (const label of labels) {
    if (label.relation !== "preceding-adjacent-sibling" || !label.text || label.truncated) continue;
    add(
      "label-sibling",
      `//label[normalize-space(.)=${xpathLiteral(label.text)}]/following-sibling::${element.tag}`,
    );
  }
  for (const label of labels) {
    if (!label.text || label.truncated) continue;
    const relation = `//label[normalize-space(.)=${xpathLiteral(label.text)}]`;
    if (label.relation === "for") add("label-for", `//${element.tag}[@id=${relation}/@for]`);
    else if (label.relation === "wrapping") add("label-wrapping", `${relation}//${element.tag}`);
  }
  for (const attribute of ["name", "id"] as const) {
    if (element[attribute] && !element.truncatedAttributes.includes(attribute)) {
      add(attribute, `//${element.tag}[@${attribute}=${xpathLiteral(element[attribute])}]`);
    }
  }
  if (
    ["button", "a"].includes(element.tag) &&
    element.text &&
    !element.truncatedAttributes.includes("text")
  ) {
    add("text", `//${element.tag}[normalize-space(.)=${xpathLiteral(element.text)}]`);
  }
  for (const [field, attribute] of [
    ["role", "role"],
    ["ariaLive", "aria-live"],
  ] as const) {
    const value = element[field];
    if (value && !element.truncatedAttributes.includes(field)) {
      add(attribute, `//${element.tag}[@${attribute}=${xpathLiteral(value)}]`);
    }
  }
  // A bare output is still an observed target. Uniqueness is established only by verify().
  if (element.tag === "output") add("tag", "//output");
  return candidates;
}

/** Enforce the UTF-8 serialized response budget, including all metadata. */
export function boundObservation(observation: Observation, maxBytes: number): Observation {
  while (Buffer.byteLength(JSON.stringify(observation), "utf8") > maxBytes) {
    observation.truncated.bytes = true;
    if (observation.elements.length) observation.elements.pop();
    else if ([observation, ...observation.frames].some((context) => context.title)) {
      // Titles can exceed the byte budget through UTF-8 or JSON escaping alone.
      for (const context of [observation, ...observation.frames]) {
        if (context.title) {
          context.title = context.title.slice(0, Math.floor(context.title.length / 2));
          context.titleTruncated = true;
        }
      }
    } else if (observation.frames.length) observation.frames.pop();
    else throw new ScannerError("INVALID_OPTIONS");
  }
  const retained = new Set(observation.frames.map((f) => f.id));
  if (observation.mainFrameId && !retained.has(observation.mainFrameId))
    observation.mainFrameId = null;
  return observation;
}
