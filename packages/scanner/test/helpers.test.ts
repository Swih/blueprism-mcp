import { describe, expect, it } from "vitest";
import {
  boundObservation,
  resolveOptions,
  safeFrameUrl,
  selectorCandidates,
  validateUrl,
  xpathLiteral,
} from "../src/helpers.js";
import type { ElementMetadata, Observation } from "../src/contracts.js";

const field = (overrides: Partial<ElementMetadata> = {}): ElementMetadata => ({
  tag: "input",
  type: "text",
  name: "firstName",
  id: "changing-123",
  text: "",
  labels: [{ text: "First Name", relation: "for", truncated: false }],
  truncatedAttributes: [],
  ...overrides,
});

describe("selector candidates", () => {
  it("quotes observed semantic attributes and rejects truncated or unsafe tags", () => {
    const status = field({
      tag: "span",
      name: "",
      id: "",
      labels: [],
      role: `note 'quoted' "status"`,
      ariaLive: "polite",
    });
    expect(selectorCandidates(status).map((c) => c.selector)).toEqual([
      `//span[@role=${xpathLiteral(status.role ?? "")}]`,
      "//span[@aria-live='polite']",
    ]);
    expect(selectorCandidates({ ...status, truncatedAttributes: ["role", "ariaLive"] })).toEqual(
      [],
    );
    expect(selectorCandidates({ ...status, truncatedAttributes: ["tag"] })).toEqual([]);
    expect(selectorCandidates({ ...status, tag: "span:odd" })).toEqual([]);
  });
  it("prefers an explicitly observed adjacent sibling while preserving label-for", () => {
    const candidates = selectorCandidates(
      field({
        labels: [
          { text: "Case reference", relation: "for", truncated: false },
          { text: "Case reference", relation: "preceding-adjacent-sibling", truncated: false },
        ],
      }),
    );
    expect(candidates.slice(0, 2).map((c) => c.basis)).toEqual(["label-sibling", "label-for"]);
    expect(candidates[0]).toMatchObject({
      selector: "//label[normalize-space(.)='Case reference']/following-sibling::input",
      stability: "unproven",
      bpCompatibility: "unproven",
    });
  });
  it("does not guess sibling relations from label-for or truncated sibling text", () => {
    expect(selectorCandidates(field()).map((c) => c.basis)).not.toContain("label-sibling");
    expect(
      selectorCandidates(
        field({
          labels: [{ text: "Case", relation: "preceding-adjacent-sibling", truncated: true }],
        }),
      ).map((c) => c.basis),
    ).not.toContain("label-sibling");
  });
  it("uses the label relationship without baking in a changing id", () => {
    const candidates = selectorCandidates(field());
    expect(candidates[0]?.selector).toBe(
      "//input[@id=//label[normalize-space(.)='First Name']/@for]",
    );
    expect(candidates.map((candidate) => candidate.stability)).toEqual([
      "unproven",
      "unproven",
      "unproven",
    ]);
    expect(candidates[0]?.selector).not.toContain("changing-123");
  });
  it("quotes both quote characters and does not interpolate XPath injection", () => {
    expect(xpathLiteral(`Sam's "name"`)).toBe(`concat('Sam', "'", 's "name"')`);
    const candidate = selectorCandidates(
      field({ name: "'] | //* | //*['", labels: [], id: "" }),
    )[0];
    expect(candidate?.selector).toBe(`//input[@name="'] | //* | //*['"]`);
  });
  it("does not create selectors from truncated attribute/label text", () => {
    expect(
      selectorCandidates(
        field({
          truncatedAttributes: ["id", "name"],
          labels: [{ text: "First", relation: "for", truncated: true }],
        }),
      ),
    ).toEqual([]);
  });
  it("uses a wrapping label without choosing an arbitrary first match", () => {
    expect(
      selectorCandidates(
        field({ labels: [{ text: "Email", relation: "wrapping", truncated: false }] }),
      )[0]?.selector,
    ).toBe("//label[normalize-space(.)='Email']//input");
  });
});

describe("URL and resource boundaries", () => {
  it("bounds titles whose JSON escaping alone exceeds the byte limit", () => {
    const observation: Observation = {
      trust: "untrusted-page-data",
      scope: "dom-prevalidation-only",
      observedAt: "test",
      mainFrameId: null,
      title: "\u0001".repeat(500),
      titleTruncated: false,
      frames: [],
      elements: [],
      truncated: { elements: false, frames: false, bytes: false, dom: false },
    };
    boundObservation(observation, 2048);
    expect(observation.title).toBeTruthy();
    expect(observation.titleTruncated).toBe(true);
    expect(observation.truncated.bytes).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(2048);
  });
  it.each([
    "file:///C:/secret",
    "javascript:alert(1)",
    "data:text/html,secret",
    "https://user:password@example.com/",
  ])("rejects unsafe navigation %s", (url) => {
    expect(() => validateUrl(url)).toThrow("INVALID_URL");
  });
  it("removes credentials, search and fragments from frame URLs", () => {
    expect(safeFrameUrl("https://user:pass@example.com/form?token=SECRET#SECRET")).toBe(
      "https://example.com/form",
    );
    expect(safeFrameUrl("data:text/html,SECRET")).toBe("[unsupported-url]");
    expect(safeFrameUrl("about:srcdoc")).toBe("about:srcdoc");
  });
  it.each([0, -1, Infinity, NaN, 100000, 1.1])(
    "rejects invalid element limit %s",
    (maxElements) => {
      expect(() => resolveOptions({ maxElements })).toThrow("INVALID_OPTIONS");
    },
  );
  it("defaults to headless with finite hard caps", () => {
    expect(resolveOptions().headless).toBe(true);
    expect(() => resolveOptions({ maxBytes: 300000 })).toThrow("INVALID_OPTIONS");
  });
  it("bounds UTF-8 bytes including candidates and metadata", () => {
    const observation: Observation = {
      trust: "untrusted-page-data",
      scope: "dom-prevalidation-only",
      observedAt: "test",
      mainFrameId: "main",
      frames: [
        {
          id: "main",
          parentId: null,
          depth: 0,
          url: "https://example.com/",
          proof: "observed-document",
        },
      ],
      elements: Array.from({ length: 50 }, () => ({
        ...field({ text: "漢".repeat(160) }),
        frameId: "main",
        candidates: selectorCandidates(field()),
      })),
      truncated: { elements: false, frames: false, bytes: false, dom: false },
    };
    const result = boundObservation(observation, 2048);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
    expect(result.truncated.bytes).toBe(true);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.frames).toHaveLength(1);
  });
});
