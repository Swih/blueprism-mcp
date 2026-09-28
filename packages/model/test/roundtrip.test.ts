import { describe, expect, it } from "vitest";
import { canonicalize, parseBpXml, serializeBpXml } from "../src/index.js";
import { listFixtures, readFixture } from "./fixtures.js";

const fixtures = listFixtures();
const BOM = String.fromCharCode(0xfeff);

it("finds every fixture", () => {
  expect(fixtures).toHaveLength(9);
});

describe.each(fixtures)("%s", (name) => {
  const source = readFixture(name);
  const first = parseBpXml(source);
  const output = serializeBpXml(first);
  const second = parseBpXml(output);

  it("parse → serialize → parse keeps the same tree", () => {
    expect(canonicalize(second)).toBe(canonicalize(first));
  });

  it("serializes deterministically", () => {
    expect(serializeBpXml(second)).toBe(output);
    expect(output.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
  });
});

// Files written by Blue Prism itself (AutomateC /export) and our Blue Prism-style Echo
// process: the serializer reproduces them byte for byte, apart from the BOM and CRLF.
describe.each(
  fixtures.filter((f) => f.startsWith("bp-export/") || f.startsWith("MCP Test - Echo")),
)("%s", (name) => {
  it("is reproduced exactly (except BOM and CRLF)", () => {
    const source = readFixture(name);
    const expected = source.replace(BOM, "").replaceAll("\r\n", "\n").replace(/\n?$/, "\n");
    expect(serializeBpXml(parseBpXml(source))).toBe(expected);
  });
});
