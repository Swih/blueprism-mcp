import { describe, expect, it } from "vitest";
import { BpXmlSerializeError, doc, el, parseBpXml, serializeBpXml, textEl } from "../src/index.js";

describe("serializeBpXml", () => {
  it("escapes attribute values so any reader gets them back exactly", () => {
    const out = serializeBpXml(doc(el("a", { v: "\"<&>'\r\n\t" })));
    expect(out).toContain('<a v="&quot;&lt;&amp;&gt;\'&#xD;&#xA;&#x9;" />');
    expect(parseBpXml(out).root.attributes[0]?.value).toBe("\"<&>'\r\n\t");
  });

  it("escapes text, keeping CR as a character reference", () => {
    const out = serializeBpXml(doc(textEl("a", '<&> "q"\r\n')));
    expect(out).toContain('<a>&lt;&amp;&gt; "q"&#xD;\n</a>');
  });

  it("refuses invalid names and characters XML cannot carry", () => {
    expect(() => serializeBpXml(doc(el("a b")))).toThrow(BpXmlSerializeError);
    expect(() => serializeBpXml(doc(el("a", { "1x": "" })))).toThrow(BpXmlSerializeError);
    expect(() => serializeBpXml(doc(textEl("a", "\u0001")))).toThrow(BpXmlSerializeError);
  });
});
