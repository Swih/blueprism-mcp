import { childElements, childText, firstChild, getAttr, parseBpXml } from "@bpdev/model";
import { assert, describe, expect, it } from "vitest";
import {
  generateQueueDefinition,
  queueDefinitionSpecSchema,
  SpecValidationError,
} from "../src/index.js";

const spec = { name: "BPDEV Synthetic Queue", createdAt: "2026-09-29T12:34:56Z" };

describe("original queue definition release", () => {
  it("emits the native namespace, key, one-attempt policy and deterministic identity", () => {
    const file = generateQueueDefinition(spec);
    const root = parseBpXml(file.xml).root;
    expect(file.fileName).toBe("BPDEV Synthetic Queue.bprelease");
    expect(getAttr(root, "xmlns:bpr")).toBe("http://www.blueprism.co.uk/product/release");
    const contents = firstChild(root, "bpr:contents");
    assert(contents);
    expect(getAttr(contents, "count")).toBe("1");
    const queue = childElements(contents)[0];
    assert(queue);
    expect(queue.name).toBe("work-queue");
    expect(getAttr(queue, "xmlns")).toBe("http://www.blueprism.co.uk/product/work-queue");
    expect(getAttr(queue, "name")).toBe(spec.name);
    expect(getAttr(queue, "key-field")).toBe("CaseKey");
    expect(getAttr(queue, "max-attempts")).toBe("1");
    expect(getAttr(queue, "id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(queue.children).toEqual([]);
    expect(childText(root, "bpr:created")).toBe("2026-09-29 12:34:56Z");
    expect(generateQueueDefinition(spec).xml).toBe(file.xml);
    expect(generateQueueDefinition({ ...spec, name: "Other Synthetic Queue" }).xml).not.toContain(
      getAttr(queue, "id"),
    );
  });

  it("rejects retry expansion, another data key, invalid dates and unknown fields", () => {
    for (const extra of [
      { maxAttempts: 2 },
      { keyField: "Password" },
      { createdAt: "2026-02-30T00:00:00Z" },
      { autoRetry: true },
    ]) {
      expect(queueDefinitionSpecSchema.safeParse({ ...spec, ...extra }).success).toBe(false);
    }
    expect(() => generateQueueDefinition({ ...spec, createdAt: "invalid" })).toThrow(
      SpecValidationError,
    );
  });

  it.each(["../escape", "bad:name", "name.", " name", "name\n"])(
    "rejects unsafe artifact names: %s",
    (name) => {
      expect(() => generateQueueDefinition({ ...spec, name })).toThrow(SpecValidationError);
    },
  );
});
