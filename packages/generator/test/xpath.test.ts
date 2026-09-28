import { describe, expect, it } from "vitest";
import {
  assessXPath,
  xpathByAttribute,
  xpathByClassToken,
  xpathByLabel,
  xpathByText,
  xpathLiteral,
} from "../src/xpath.js";

// No XPath DOM evaluator is installed. These are output-contract and injection tests,
// not evidence that a selector is unique or behaves correctly in a particular browser.

describe("xpathLiteral", () => {
  it.each([
    { value: "", expected: "''" },
    { value: "plain", expected: "'plain'" },
    { value: "O'Brien", expected: `"O'Brien"` },
    { value: 'Say "hello"', expected: `'Say "hello"'` },
    { value: "'", expected: `"'"` },
    { value: '"', expected: `'"'` },
    { value: "'\"", expected: String.raw`concat('', "'", '"')` },
    { value: "\"'", expected: String.raw`concat('"', "'", '')` },
    { value: "'\"'", expected: String.raw`concat('', "'", '"', "'", '')` },
    { value: "''\"", expected: String.raw`concat('', "'", '', "'", '"')` },
    {
      value: `Sam's "quoted" value`,
      expected: String.raw`concat('Sam', "'", 's "quoted" value')`,
    },
    {
      value: String.raw`C:\users\O'Brien "docs"`,
      expected: String.raw`concat('C:\users\O', "'", 'Brien "docs"')`,
    },
    { value: "é漢字🧪\t\r\n", expected: "'é漢字🧪\t\r\n'" },
    { value: "A&B <tag>", expected: "'A&B <tag>'" },
  ])("quotes $value without XML encoding or backslash escaping", ({ value, expected }) => {
    expect(xpathLiteral(value)).toBe(expected);
  });

  it.each([
    {
      value: "'] | //* | //*['",
      expected: `"'] | //* | //*['"`,
    },
    {
      value: '"] | //* | //*["',
      expected: `'"] | //* | //*["'`,
    },
    {
      value: String.raw`x' or @admin = "true" or '`,
      expected: String.raw`concat('x', "'", ' or @admin = "true" or ', "'", '')`,
    },
  ])("keeps injection payload $value inside string literals", ({ value, expected }) => {
    expect(xpathLiteral(value)).toBe(expected);
  });
});

describe("xpathByAttribute", () => {
  it("matches a caller-selected stable attribute by exact equality", () => {
    expect(xpathByAttribute("data-testid", "save")).toBe("//*[@data-testid = 'save']");
    expect(xpathByAttribute("name", "email", "input")).toBe("//input[@name = 'email']");
  });

  it("preserves empty values and whitespace rather than changing attribute equality", () => {
    expect(xpathByAttribute("value", "")).toBe("//*[@value = '']");
    expect(xpathByAttribute("data-key", " A\tB\n ")).toBe("//*[@data-key = ' A\tB\n ']");
  });

  it("leaves outer XML and Blue Prism escaping to the caller", () => {
    expect(xpathByAttribute("data-key", 'A&B <C> [Item] "x"')).toBe(
      `//*[@data-key = 'A&B <C> [Item] "x"']`,
    );
  });

  it.each(["id", "data-testid", "aria-label", "_private", "a.b", "name9"])(
    "accepts the conservative XML name %s",
    (name) => {
      expect(xpathByAttribute(name, "v", name)).toBe(`//${name}[@${name} = 'v']`);
    },
  );
});

describe("xpathByText", () => {
  it("matches the full normalized element string-value including descendant text", () => {
    expect(xpathByText("Save", "button")).toBe("//button[normalize-space(.) = 'Save']");
    expect(xpathByText("Save")).toBe("//*[normalize-space(.) = 'Save']");
  });

  it("normalizes input using exactly the XPath 1.0 whitespace characters", () => {
    expect(xpathByText(" \tFirst\r\n  Name\t ", "label")).toBe(
      "//label[normalize-space(.) = 'First Name']",
    );
  });

  it("preserves NBSP and other Unicode spacing rather than applying JavaScript trim", () => {
    expect(xpathByText("\u00a0 First\u00a0Name \u2003")).toBe(
      "//*[normalize-space(.) = '\u00a0 First\u00a0Name \u2003']",
    );
  });

  it.each(["", " ", "\t\r\n", " \n\t "])("rejects empty normalized text %j", (value) => {
    expect(() => xpathByText(value)).toThrow(/must not be empty/);
  });
});

describe("xpathByClassToken", () => {
  it("pads both sides of the token so btn cannot match btn-primary", () => {
    expect(xpathByClassToken("btn", "button")).toBe(
      "//button[contains(concat(' ', normalize-space(@class), ' '), ' btn ')]",
    );
  });

  it("accepts punctuation and NBSP in a single token", () => {
    expect(xpathByClassToken("sm:hover-active")).toBe(
      "//*[contains(concat(' ', normalize-space(@class), ' '), ' sm:hover-active ')]",
    );
    expect(xpathByClassToken("a\u00a0b")).toBe(
      "//*[contains(concat(' ', normalize-space(@class), ' '), ' a\u00a0b ')]",
    );
  });

  it("quotes a token containing both quote characters", () => {
    expect(xpathByClassToken(`a'b"c`)).toBe(
      String.raw`//*[contains(concat(' ', normalize-space(@class), ' '), concat(' a', "'", 'b"c '))]`,
    );
  });

  it.each(["", " ", "two tokens", " btn", "btn ", "a\tb", "a\rb", "a\nb", "a\fb"])(
    "rejects empty or multiple class tokens %j",
    (token) => {
      expect(() => xpathByClassToken(token)).toThrow(/class token/);
    },
  );
});

describe("xpathByLabel", () => {
  it("joins label for values to control ids, rejecting missing or empty associations", () => {
    expect(xpathByLabel("First name")).toBe(
      "//input[@id = //label[normalize-space(.) = 'First name' and @for != '']/@for]",
    );
  });

  it("supports an explicit control name and the same normalization as text selectors", () => {
    expect(xpathByLabel(" \tCountry\n ", "select")).toBe(
      "//select[@id = //label[normalize-space(.) = 'Country' and @for != '']/@for]",
    );
  });

  it("uses all matching labels rather than an arbitrary position or sibling relationship", () => {
    expect(xpathByLabel("Notes", "textarea")).toBe(
      "//textarea[@id = //label[normalize-space(.) = 'Notes' and @for != '']/@for]",
    );
  });

  it.each(["", " \t\n\r "])("rejects empty normalized labels %j", (value) => {
    expect(() => xpathByLabel(value)).toThrow(/must not be empty/);
  });
});

describe("selector injection boundaries", () => {
  const invalidNames = [
    "",
    "1input",
    "-input",
    ".input",
    " input",
    "input ",
    "input\n",
    "input\r\n",
    "input\u2028",
    "data-*",
    "svg:rect",
    "ancestor::input",
    "input[1]",
    "input | //*",
    "/html/body/input",
    "div/input",
    "@id",
    "text()",
    "id = 'x' or @name",
    'id"] | //*',
    "élement",
    "input\u0000",
  ];

  it.each(invalidNames)("rejects unsupported attribute and element names %j", (name) => {
    expect(() => xpathByAttribute(name, "value")).toThrow(/Invalid XPath name/);
    expect(() => xpathByAttribute("id", "value", name)).toThrow(/Invalid XPath name/);
    expect(() => xpathByText("text", name)).toThrow(/Invalid XPath name/);
    expect(() => xpathByClassToken("token", name)).toThrow(/Invalid XPath name/);
    expect(() => xpathByLabel("label", name)).toThrow(/Invalid XPath name/);
  });

  it("allows an element wildcard but not an attribute wildcard", () => {
    expect(xpathByAttribute("id", "x", "*")).toBe("//*[@id = 'x']");
    expect(() => xpathByAttribute("*", "x")).toThrow(/Invalid XPath name/);
  });

  it("quotes hostile values consistently in every builder", () => {
    const payload = String.raw`x'" or @admin='yes`;
    const literal = String.raw`concat('x', "'", '" or @admin=', "'", 'yes')`;
    expect(xpathByAttribute("id", payload)).toBe(`//*[@id = ${literal}]`);
    expect(xpathByText(payload)).toBe(`//*[normalize-space(.) = ${literal}]`);
    expect(xpathByLabel(payload)).toBe(
      `//input[@id = //label[normalize-space(.) = ${literal} and @for != '']/@for]`,
    );
    // Class tokens cannot contain spaces, but XPath punctuation is still literal data.
    expect(xpathByClassToken(String.raw`x'"]|//*`)).toBe(
      String.raw`//*[contains(concat(' ', normalize-space(@class), ' '), concat(' x', "'", '"]|//* '))]`,
    );
  });
});

describe("assessXPath", () => {
  it.each(["", " \t\n "])("warns about empty input %j", (xpath) => {
    expect(assessXPath(xpath).map((issue) => issue.code)).toEqual(["empty-xpath"]);
  });

  it("reports independent fragility warnings in a deterministic order", () => {
    expect(assessXPath("/html/body/div[2]/input[1]").map((issue) => issue.code)).toEqual([
      "absolute-html-path",
      "positional-predicate",
    ]);
  });

  it.each(["//html/body/input", "(/html/body/input)", "//button | /html/body/input"])(
    "recognizes common HTML-rooted paths %s",
    (xpath) => {
      expect(assessXPath(xpath).map((issue) => issue.code)).toContain("absolute-html-path");
    },
  );

  it.each([
    "(//input)[2]",
    "//input[ 10 ]",
    "//input[-1]",
    "//input[1.0]",
    "//input[.5]",
    "//input[position() = 2]",
    "//input[last()]",
    "//input[position () = last () - 1]",
  ])("recognizes common positional forms %s", (xpath) => {
    expect(assessXPath(xpath).map((issue) => issue.code)).toEqual(["positional-predicate"]);
  });

  it.each(["//*", " .//* ", "descendant::*"])("warns about broad selection %s", (xpath) => {
    expect(assessXPath(xpath).map((issue) => issue.code)).toEqual(["broad-selector"]);
  });

  it("does not flag numeric attribute comparisons or substrings of HTML element names", () => {
    expect(assessXPath("//input[@tabindex = 2]")).toEqual([]);
    expect(assessXPath("/htmlish/body")).toEqual([]);
  });

  it("ignores path and position syntax inside either quote style and concat literals", () => {
    const payloads = ["/html/body[2] position() last()", `'" /html/body[2] position() last()`];
    for (const payload of payloads) {
      expect(assessXPath(xpathByAttribute("data-key", payload))).toEqual([]);
      expect(assessXPath(xpathByText(payload))).toEqual([]);
    }
    expect(assessXPath(`//input[@name = "/html/body[2] last()"]`)).toEqual([]);
  });

  it("does not confuse literal values with real positional syntax outside them", () => {
    expect(assessXPath(`//input[@name = '[2] last()'][3]`).map((issue) => issue.code)).toEqual([
      "positional-predicate",
    ]);
  });

  it("can return no warnings for ambiguous or invalid XPath: this is not validation", () => {
    expect(assessXPath(xpathByText("Save", "button"))).toEqual([]);
    expect(assessXPath("//input[")).toEqual([]);
  });
});
