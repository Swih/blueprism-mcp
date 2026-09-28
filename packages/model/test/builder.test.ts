import { describe, expect, it } from "vitest";
import {
  canonicalize,
  doc,
  el,
  getAttr,
  parseBpXml,
  serializeBpXml,
  setAttr,
  text,
  textEl,
} from "../src/index.js";

const process = doc(
  el("process", { name: "Demo", version: "1.0", type: undefined, bpversion: "7.5.1.18099" }, [
    el("view", {}, [textEl("camerax", "0"), textEl("zoom", "1.25", { version: "2" })]),
    el("preconditions"),
    el("stage", { stageid: "s1", name: "Start", type: "Start" }, [
      el("display", { x: "15", y: "-90" }),
      textEl("onsuccess", "s2"),
    ]),
    el("stage", { stageid: "s2", name: "End", type: "End" }, [textEl("initialvalue", "")]),
  ]),
);

const expected = `<?xml version="1.0" encoding="utf-8"?>
<process name="Demo" version="1.0" bpversion="7.5.1.18099">
  <view>
    <camerax>0</camerax>
    <zoom version="2">1.25</zoom>
  </view>
  <preconditions />
  <stage stageid="s1" name="Start" type="Start">
    <display x="15" y="-90" />
    <onsuccess>s2</onsuccess>
  </stage>
  <stage stageid="s2" name="End" type="End">
    <initialvalue />
  </stage>
</process>
`;

describe("builder", () => {
  it("builds Blue Prism-style XML (undefined attributes and empty text left out)", () => {
    expect(serializeBpXml(process)).toBe(expected);
  });

  it("builds trees that survive a round trip", () => {
    expect(canonicalize(parseBpXml(serializeBpXml(process)))).toBe(canonicalize(process));
  });

  it("accepts text nodes and strings as children", () => {
    expect(el("a", {}, [text("x"), "y"]).children).toEqual([
      { kind: "text", value: "x" },
      { kind: "text", value: "y" },
    ]);
  });

  it("updates attributes in place, keeping their order", () => {
    const stage = el("stage", { stageid: "s1", name: "Start" });
    setAttr(stage, "stageid", "s9");
    setAttr(stage, "type", "Start");
    expect(stage.attributes.map((a) => a.name)).toEqual(["stageid", "name", "type"]);
    expect(getAttr(stage, "stageid")).toBe("s9");
  });
});
