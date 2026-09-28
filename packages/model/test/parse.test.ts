import { describe, expect, it } from "vitest";
import {
  BpXmlParseError,
  canonicalize,
  childElements,
  getAttr,
  parseBpXml,
  serializeBpXml,
  textContent,
  type BpElement,
} from "../src/index.js";

function root(xml: string): BpElement {
  return parseBpXml(xml).root;
}

describe("parseBpXml", () => {
  it("keeps names, prefixes, namespace declarations and attribute order", () => {
    const r = root(
      '<bpr:release xmlns:bpr="urn:r" z="1" a="2"><bpr:name>n</bpr:name></bpr:release>',
    );
    expect(r.name).toBe("bpr:release");
    expect(r.attributes).toEqual([
      { name: "xmlns:bpr", value: "urn:r" },
      { name: "z", value: "1" },
      { name: "a", value: "2" },
    ]);
    expect(childElements(r)[0]?.name).toBe("bpr:name");
  });

  it("keeps CR, LF and TAB verbatim in text and attributes (no normalisation)", () => {
    const r = root('<a n="x\r\ny\tz">line 1\r\nline 2</a>');
    expect(getAttr(r, "n")).toBe("x\r\ny\tz");
    expect(textContent(r)).toBe("line 1\r\nline 2");
  });

  it("decodes the XML entities and character references", () => {
    const r = root('<a v="&quot;&lt;&gt;&amp;&apos;&#xD;&#xA;&#233;">&lt;&amp;&#x41;</a>');
    expect(getAttr(r, "v")).toBe("\"<>&'\r\né");
    expect(textContent(r)).toBe("<&A");
  });

  it("keeps self-closing and empty elements apart", () => {
    const xml = "<a><b /><c></c></a>";
    expect(serializeBpXml(parseBpXml(xml))).toContain("  <b />\n  <c></c>\n");
  });

  it("drops indentation between elements but keeps whitespace inside leaves", () => {
    const r = root("<a>\r\n  <b>  </b>\n\t<c>\r\n\r\n</c>\n</a>");
    expect(r.children.map((c) => c.kind)).toEqual(["element", "element"]);
    expect(childElements(r).map(textContent)).toEqual(["  ", "\r\n\r\n"]);
  });

  it("keeps mixed content verbatim", () => {
    const r = root("<a>x <b>y</b> z</a>");
    expect(canonicalize(r)).toBe('a\n  "x "\n  b\n    "y"\n  " z"');
    expect(serializeBpXml(parseBpXml(serializeBpXml({ root: r })))).toContain(
      "<a>x <b>y</b> z</a>",
    );
  });

  it("ignores a BOM and the XML declaration", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(root(`${bom}<?xml version="1.0" encoding="utf-8"?>\r\n<a />`).name).toBe("a");
  });

  it("turns CDATA into text", () => {
    expect(textContent(root("<a>x<![CDATA[<&>]]>y</a>"))).toBe("x<&>y");
  });

  it("reports malformed XML with its position", () => {
    const error = catchError(() => parseBpXml("<a>\n  <b></a>"));
    expect(error).toBeInstanceOf(BpXmlParseError);
    expect((error as BpXmlParseError).line).toBe(2);
  });

  it.each([
    ["an empty input", ""],
    ["text only", "hello"],
    ["an unclosed root", "<a><b /></a"],
    ["a second root", "<a /><b />"],
    ["an HTML entity", "<a>&nbsp;</a>"],
    ["a DOCTYPE", "<!DOCTYPE a><a />"],
    ["a comment", "<a><!-- no --></a>"],
    ["a processing instruction", "<a><?pi x?></a>"],
  ])("rejects %s", (_, xml) => {
    expect(() => parseBpXml(xml)).toThrow(BpXmlParseError);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}
