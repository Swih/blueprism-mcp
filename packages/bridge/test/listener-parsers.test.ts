import { getAttr, serializeBpXml } from "@bpdev/model";
import { assert, describe, expect, it } from "vitest";
import { CommandFailedError, UnexpectedOutputError } from "../src/errors.js";
import {
  isStatusReplyComplete,
  parseAvailability,
  parseBusy,
  parseListenerStatus,
  parseOutputs,
  parseVersion,
} from "../src/listener/parsers.js";
import { listenerFixtureLines, publicErrorText } from "./listener-test-helpers.js";

describe("listener captured reply contracts", () => {
  it("reads version, availability and busy fixtures", () => {
    expect(parseVersion(listenerFixtureLines("version"))).toEqual({
      product: "AUTOMATE RESOURCE PC / LISTENER",
      version: 4,
    });
    expect(parseBusy(listenerFixtureLines("busy"))).toBe(false);
    expect(parseAvailability(listenerFixtureLines("availability"))).toBe("Exclusive");
  });
  it("reads captured sessions without recalculating Total running", () => {
    expect(parseListenerStatus(listenerFixtureLines("status"))).toEqual({
      totalRunning: 2,
      sessions: [
        {
          status: "FAILED",
          sessionId: "2d1a74d6-b4f6-4ef7-a6e3-1b8da0119b9f",
          message: "System Exception : RPA Challenge home page did not load",
        },
        { status: "COMPLETED", sessionId: "c3abb528-1570-42be-ba95-ad54a5c9bbdc" },
      ],
    });
  });
  it("reads captured scalar output values and elements", () => {
    const outputs = parseOutputs(listenerFixtureLines("outputs"));
    expect(outputs.map(({ name, type, value }) => ({ name, type, value }))).toEqual([
      { name: "Echo", type: "text", value: "Claude" },
      { name: "Start Text", type: "text", value: "START" },
    ]);
    assert(outputs[0]);
    expect(getAttr(outputs[0].element, "value")).toBe("Claude");
  });
  it.each(["invalid-command", "invalid-id", "session-not-found", "user-not-set"])(
    "classifies captured %s",
    (name) => {
      expect(() => parseOutputs(listenerFixtureLines(name))).toThrow(CommandFailedError);
    },
  );
  it("distinguishes incomplete status from a terminal or unsupported line", () => {
    expect(isStatusReplyComplete([])).toBe(false);
    expect(isStatusReplyComplete(["RESOURCE UNIT"])).toBe(false);
    expect(isStatusReplyComplete(listenerFixtureLines("status").slice(0, -1))).toBe(false);
    expect(isStatusReplyComplete(listenerFixtureLines("status"))).toBe(true);
    expect(isStatusReplyComplete(["RESOURCE UNIT", "undelimited exception continuation"])).toBe(
      true,
    );
  });
});

describe("listener data redaction after parsing", () => {
  it("masks password value AND the element subtree, including unknown attributes and echoes", () => {
    const outputs = parseOutputs([
      'OUTPUTS:<outputs><output name="Password" type="password" value="s&amp;ecret" copied="s&amp;ecret"><data>s&amp;ecret</data></output><output name="Echo" type="text" value="s&amp;ecret" /></outputs>',
    ]);
    expect(outputs[0]?.value).toBe("***");
    expect(outputs[0]?.redacted).toBe(true);
    expect(outputs[0]?.element.children).toEqual([]);
    expect(outputs[1]?.value).toBe("***");
    expect(JSON.stringify(outputs)).not.toContain("s&ecret");
    expect(JSON.stringify(outputs)).not.toContain("s&amp;ecret");
  });
  it("decodes named/numeric entities before redacting data fields", () => {
    const [output] = parseOutputs(
      [
        'OUTPUTS:<outputs><output name="Token A&amp;B" type="text" value="A&#38;B"><data info="A&#x26;B">A&amp;B</data></output></outputs>',
      ],
      ["A&B"],
    );
    expect(output?.name).toBe("Token ***");
    expect(output?.value).toBe("***");
    expect(JSON.stringify(output)).not.toContain("A&B");
    assert(output);
    expect(serializeBpXml({ root: output.element })).toContain('info="***"');
  });
  it("keeps structural GUIDs and states intact with single-character secrets", () => {
    const result = parseListenerStatus(listenerFixtureLines("status"), ["e", "1", "FAILED"]);
    expect(result.sessions[0]?.sessionId).toBe("2d1a74d6-b4f6-4ef7-a6e3-1b8da0119b9f");
    expect(result.sessions[0]?.status).toBe("FAILED");
    expect(result.sessions[1]?.status).toBe("COMPLETED");
    expect(result.sessions[0]?.message).toContain("Syst***m");
  });
  it("handles empty, overlapping and regex-special secrets without touching type markers", () => {
    const [output] = parseOutputs(
      ['OUTPUTS:<outputs><output name="Value" type="text" value="abc ab a+b text" /></outputs>'],
      ["", "ab", "abc", "a+b", "text"],
    );
    expect(output?.value).toBe("*** *** *** ***");
    expect(output?.type).toBe("text");
    assert(output);
    expect(getAttr(output.element, "type")).toBe("text");
  });
  it("withholds collections with schema-level password types separate from row values", () => {
    const [output] = parseOutputs([
      'OUTPUTS:<outputs><output name="Rows" type="collection" value="hidden"><fields><field name="Pwd" type="password" /></fields><rows><row><field name="Pwd" value="unregistered-secret" /></row></rows></output></outputs>',
    ]);
    expect(output).toMatchObject({ type: "collection", value: "***", redacted: true });
    expect(output?.element.children).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("unregistered-secret");
  });
  it("withholds nested password payloads, even without a top-level value", () => {
    const [output] = parseOutputs([
      'OUTPUTS:<outputs><output name="Data" type="text"><cell type="password" copied="hidden"><value>hidden</value></cell></output></outputs>',
    ]);
    expect(output?.value).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("hidden");
  });

  it("redacts unknown nested type metadata instead of exempting arbitrary strings", () => {
    const outputs = parseOutputs(
      [
        'OUTPUTS:<outputs><output name="X" type="text"><data type="private-token">ok</data></output></outputs>',
      ],
      ["private-token"],
    );
    expect(JSON.stringify(outputs)).not.toContain("private-token");
    expect(outputs[0]?.type).toBe("text");
  });

  it("withholds data when secret context exceeds the redactor budget", () => {
    const [output] = parseOutputs(
      ['OUTPUTS:<outputs><output name="X" type="text" value="private-value" /></outputs>'],
      ["x".repeat(16_385)],
    );
    expect(output?.value).toBe("***");
    expect(output?.type).toBe("text");
  });
});

describe("parser errors never retain raw replies", () => {
  const secret = "RAW_SECRET_SENTINEL";
  it.each([
    `OUTPUTS:<outputs><output name="X" type="${secret}" /></outputs>`,
    `OUTPUTS:<outputs><${secret} /></outputs>`,
    `OUTPUTS:<outputs value="${secret}">broken</outputs>`,
    `OUTPUTS:<outputs><output name="X" type="password" value="${secret}&bad;" /></outputs>`,
    `OUTPUTS:<!DOCTYPE outputs [<!ENTITY s "${secret}">]><outputs/>`,
    `INVALID COMMAND ${secret}`,
  ])("suppresses raw XML and error-like prefixes: %s", (reply) => {
    try {
      parseOutputs([reply]);
      expect.fail("should reject");
    } catch (error) {
      expect(error).toBeInstanceOf(UnexpectedOutputError);
      expect(publicErrorText(error)).not.toContain(secret);
      expect(error).not.toHaveProperty("cause");
    }
  });
  it("does not interpolate unexpected status lines into reasons", () => {
    try {
      parseListenerStatus(["RESOURCE UNIT", secret, "Total running: 0"]);
      expect.fail("should reject");
    } catch (error) {
      expect(error).toBeInstanceOf(UnexpectedOutputError);
      expect(publicErrorText(error)).not.toContain(secret);
    }
  });
  it("rejects missing terminators, extra lines and oversized numeric fields", () => {
    expect(() => parseListenerStatus(["RESOURCE UNIT"])).toThrow(UnexpectedOutputError);
    expect(() => parseBusy(["no", "yes"])).toThrow(UnexpectedOutputError);
    expect(() => parseVersion(["AUTOMATE RESOURCE PC / LISTENER 9007199254740992"])).toThrow(
      UnexpectedOutputError,
    );
    expect(() => parseListenerStatus(["RESOURCE UNIT", "Total running: 9007199254740992"])).toThrow(
      UnexpectedOutputError,
    );
  });
  it("bounds XML nesting", () => {
    const xml = "<x>".repeat(66) + secret + "</x>".repeat(66);
    expect(() =>
      parseOutputs([`OUTPUTS:<outputs><output name="X" type="text">${xml}</output></outputs>`]),
    ).toThrow("unsupported XML structure");
  });
});
