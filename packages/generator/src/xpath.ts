/**
 * Small, dependency-free XPath 1.0 builders for browser selectors. Selectors search the
 * document with `//`; they do not assert uniqueness, visibility, or attribute stability.
 * Values are XPath strings, not XML or Blue Prism expressions: escape those outer formats
 * separately when serializing or supplying dynamic Wait parameters.
 */

/** Quote a value without letting it introduce XPath syntax. XPath has no backslash escapes. */
export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(`, "'", `)})`;
}

/**
 * Accept a conservative ASCII subset of unprefixed XML names. Namespace prefixes,
 * Unicode names, axes, predicates, and paths are intentionally unsupported.
 */
function checkedName(name: string): string {
  // Checking every character separately also rejects a final newline (unlike a `$` anchor).
  if (!/^[A-Za-z_]/.test(name) || /[^A-Za-z0-9_.-]/.test(name)) {
    throw new Error(`Invalid XPath name: ${JSON.stringify(name)}`);
  }
  return name;
}

function checkedElementName(name: string): string {
  return name === "*" ? name : checkedName(name);
}

/** Match XPath 1.0 normalize-space(), which only collapses space, tab, CR, and LF. */
function normalizedText(value: string): string {
  const normalized = value.replace(/[ \t\r\n]+/g, " ").replace(/^ | $/g, "");
  if (normalized.length === 0) throw new Error("XPath text must not be empty after normalization");
  return normalized;
}

/** Exact attribute equality. The caller must choose a stable attribute and value. */
export function xpathByAttribute(attributeName: string, value: string, elementName = "*"): string {
  const element = checkedElementName(elementName);
  const attribute = checkedName(attributeName);
  return `//${element}[@${attribute} = ${xpathLiteral(value)}]`;
}

/**
 * Exact normalized element string-value, including descendant text. Empty normalized
 * text is rejected. NBSP is preserved; matching is case-sensitive and not visibility-aware.
 */
export function xpathByText(value: string, elementName = "*"): string {
  const element = checkedElementName(elementName);
  return `//${element}[normalize-space(.) = ${xpathLiteral(normalizedText(value))}]`;
}

/**
 * Match a whole class token, never a substring. Reject empty tokens and HTML ASCII
 * whitespace. XPath 1.0 normalize-space() cannot split form feeds in the DOM class value.
 */
export function xpathByClassToken(token: string, elementName = "*"): string {
  const element = checkedElementName(elementName);
  if (token.length === 0 || /[ \t\r\n\f]/.test(token)) {
    throw new Error("XPath class token must be nonempty and contain no HTML ASCII whitespace");
  }
  return (
    `//${element}[contains(concat(' ', normalize-space(@class), ' '), ` +
    `${xpathLiteral(` ${token} `)})]`
  );
}

/**
 * Match an element whose id equals an explicit HTML label's nonempty for attribute.
 * Both searches are document-wide. Only explicit for/id relationships are supported:
 * no sibling guesses, implicit wrapping labels, or accessible-name computation.
 */
export function xpathByLabel(value: string, elementName = "input"): string {
  const element = checkedElementName(elementName);
  const label = xpathLiteral(normalizedText(value));
  return `//${element}[@id = //label[normalize-space(.) = ${label} and @for != '']/@for]`;
}

export type XPathIssueCode =
  "empty-xpath" | "absolute-html-path" | "positional-predicate" | "broad-selector";

export interface XPathIssue {
  readonly code: XPathIssueCode;
  readonly message: string;
}

/**
 * Heuristic warnings about common fragile patterns, ignoring quoted string contents.
 * This is neither an XPath parser nor a DOM check: an empty result proves nothing about
 * syntax, uniqueness, stability, visibility, or whether the selector matches at all.
 */
export function assessXPath(xpath: string): XPathIssue[] {
  if (xpath.trim().length === 0) {
    return [{ code: "empty-xpath", message: "The XPath is empty." }];
  }

  const syntax = xpath.replace(/'[^']*'|"[^"]*"/g, "''");
  const issues: XPathIssue[] = [];
  if (/(?:^|[|(])\s*\/{1,2}html(?=\s*(?:\/|\[|$))/i.test(syntax)) {
    issues.push({
      code: "absolute-html-path",
      message: "A path rooted at HTML can depend on the page's layout; prefer a stable anchor.",
    });
  }
  if (
    /\[\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*\]/.test(syntax) ||
    /\b(?:position|last)\s*\(\s*\)/.test(syntax)
  ) {
    issues.push({
      code: "positional-predicate",
      message: "A positional predicate can select a different element when document order changes.",
    });
  }
  if (/^\s*(?:\.?\/\/\*|descendant::\*)\s*$/.test(syntax)) {
    issues.push({
      code: "broad-selector",
      message: "An unfiltered wildcard selector can match many elements; add a stable anchor.",
    });
  }
  return issues;
}
