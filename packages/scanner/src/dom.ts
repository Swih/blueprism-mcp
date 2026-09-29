import type { ElementMetadata, ObservedLabel, VerificationReason } from "./contracts.js";

export interface DomObservation {
  title: string;
  titleTruncated: boolean;
  elements: ElementMetadata[];
  truncated: boolean;
  domTruncated: boolean;
}

/** Fixed shipped extractor. No caller-provided JavaScript or property/value reads. */
export function observeDom(limits: {
  maxElements: number;
  maxTextLength: number;
  maxDomNodes: number;
}): DomObservation {
  const elements: ElementMetadata[] = [];
  const cap = limits.maxTextLength;
  const clip = (value: string): { text: string; truncated: boolean } => ({
    text: value.slice(0, cap),
    truncated: value.length > cap,
  });
  // Skip controls even when nested in a label/button/link: textarea text is a value.
  const safeText = (root: Element): { text: string; truncated: boolean } => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest("input,textarea,select,script,style,[contenteditable]")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = "";
    let visits = 0;
    let node = walker.nextNode();
    while (node && visits < 1000 && text.length <= cap) {
      text += (node.textContent ?? "").slice(0, cap + 1);
      visits++;
      node = walker.nextNode();
    }
    // Match XPath normalize-space: do not trim non-breaking or Unicode spaces.
    const result = clip(text.replace(/[\t\r\n ]+/g, " ").replace(/^ | $/g, ""));
    return { text: result.text, truncated: result.truncated || node !== null };
  };
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  const title = clip(document.title);
  let node = walker.nextNode();
  let visited = 0;
  let truncated = false;
  while (node && visited < limits.maxDomNodes) {
    visited++;
    if (
      node instanceof HTMLElement &&
      (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "OUTPUT"].includes(node.tagName) ||
        node.hasAttribute("aria-live") ||
        (node.getAttribute("role") ?? "")
          .split(/[\t\r\n\f ]+/)
          .some((role) =>
            ["status", "alert", "log", "marquee", "timer", "progressbar"].includes(role),
          ))
    ) {
      if (elements.length >= limits.maxElements) {
        truncated = true;
        break;
      }
      const observedTag = node.tagName.toLowerCase();
      const tag = ["input", "textarea", "select", "button", "a", "output"].includes(observedTag)
        ? { text: observedTag, truncated: false }
        : clip(observedTag);
      const raw = {
        tag,
        type: clip(node.getAttribute("type") ?? ""),
        name: clip(node.getAttribute("name") ?? ""),
        id: clip(node.getAttribute("id") ?? ""),
        role: clip(node.getAttribute("role") ?? ""),
        ariaLive: clip(node.getAttribute("aria-live") ?? ""),
        // Never collect document-wide text, or the contents of value-bearing controls.
        text: ["input", "textarea", "select", "body", "html"].includes(observedTag)
          ? { text: "", truncated: false }
          : safeText(node),
      };
      const labels: ObservedLabel[] = [];
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLButtonElement ||
        node instanceof HTMLOutputElement
      ) {
        const previous = node.previousElementSibling;
        if (
          previous instanceof HTMLLabelElement &&
          previous.parentElement === node.parentElement &&
          previous.nextElementSibling === node
        ) {
          labels.push({ ...safeText(previous), relation: "preceding-adjacent-sibling" });
        }
        const associated = node.labels;
        for (let i = 0; associated && i < Math.min(associated.length, 2); i++) {
          const label = associated.item(i);
          labels.push({
            ...safeText(label),
            relation: label.hasAttribute("for") ? "for" : "wrapping",
          });
        }
      }
      elements.push({
        tag: tag.text,
        type: raw.type.text,
        name: raw.name.text,
        id: raw.id.text,
        text: raw.text.text,
        role: raw.role.text,
        ariaLive: raw.ariaLive.text,
        labels,
        truncatedAttributes: (
          ["tag", "type", "name", "id", "text", "role", "ariaLive"] as const
        ).filter((k) => raw[k].truncated),
      });
    }
    node = walker.nextNode();
  }
  return {
    title: title.text,
    titleTruncated: title.truncated,
    elements,
    truncated,
    domTruncated: node !== null && visited >= limits.maxDomNodes,
  };
}

export interface DomVerification {
  count: number | null;
  visible: boolean | null;
  reason: VerificationReason;
}

/** XPath is passed as data to the DOM evaluator, never to eval or a selector engine chain. */
export function verifyDom(xpath: string): DomVerification {
  try {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const count = result.snapshotLength;
    if (count === 0) return { count, visible: null, reason: "not-found" };
    if (count !== 1) return { count, visible: null, reason: "ambiguous" };
    const node = result.snapshotItem(0);
    // Confirmation/status elements are valid targets too. No contents are read here.
    if (!(node instanceof HTMLElement)) {
      return { count, visible: null, reason: "unsupported-target" };
    }
    const style = getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    const visible =
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      bounds.width > 0 &&
      bounds.height > 0;
    return { count, visible, reason: visible ? "unique-visible" : "not-visible" };
  } catch {
    return { count: null, visible: null, reason: "invalid-selector" };
  }
}
