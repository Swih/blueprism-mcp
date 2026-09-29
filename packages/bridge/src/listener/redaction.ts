import { getAttr, type BpElement } from "@bpdev/model";

export const REDACTED = "***";

/** Only apply to decoded data, never to protocol markers, identifiers or XML source. */
export function redactText(value: string, secrets: readonly string[]): string {
  const candidates = [...new Set(secrets.filter((secret) => secret !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  if (candidates.length === 0) return value;
  // Large password outputs must not turn into an unbounded regular expression. Withhold
  // the field if the redaction context is too large; never fall back to returning it raw.
  if (
    candidates.length > 256 ||
    candidates.reduce((sum, secret) => sum + secret.length, 0) > 16_384
  ) {
    return REDACTED;
  }
  const pattern = candidates.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return value.replace(new RegExp(pattern.join("|"), "g"), () => REDACTED);
}

/**
 * A password subtree is opaque. Collections are also withheld until their schema-level
 * field types (which may be separate from row values) have a qualified decoding contract.
 * A recursive search for `type="password"` alone cannot protect such collections.
 */
export function redactElement(
  element: BpElement,
  secrets: readonly string[],
  depth = 0,
): BpElement {
  if (depth > 64) throw new Error("Listener XML nesting limit exceeded");
  const type = getAttr(element, "type")?.toLowerCase();
  if (type === "password" || type === "collection") {
    return {
      kind: "element",
      name: element.name,
      attributes: element.attributes
        .filter((attribute) => ["name", "type", "value"].includes(attribute.name))
        .map((attribute) => ({
          name: attribute.name,
          value:
            attribute.name === "value"
              ? REDACTED
              : attribute.name === "type"
                ? attribute.value
                : redactText(attribute.value, secrets),
        })),
      children: [],
      selfClosing: true,
    };
  }
  return {
    ...element,
    attributes: element.attributes.map((attribute) => ({
      name: attribute.name,
      value:
        attribute.name === "type" && depth === 0
          ? attribute.value
          : redactText(attribute.value, secrets),
    })),
    children: element.children.map((child) =>
      child.kind === "element"
        ? redactElement(child, secrets, depth + 1)
        : { kind: "text", value: redactText(child.value, secrets) },
    ),
  };
}
