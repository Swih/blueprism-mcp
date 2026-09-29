import {
  childElements,
  childText,
  firstChild,
  getAttr,
  listStages,
  parseBpXml,
} from "@bpdev/model";
import { assert, describe, expect, it } from "vitest";
import { generateQueueSeed, queueSeedSpecSchema, SpecValidationError } from "../src/index.js";

const spec = {
  name: "BPDEV Synthetic Seed",
  queueName: "BPDEV Synthetic Queue",
  items: [{ CaseKey: 'case-1 <&> " [Data.x]' }, { CaseKey: "case-2" }],
};

describe("typed queue seed process", () => {
  it("writes real Collection stages and literal field values without expressions", () => {
    const file = generateQueueSeed(spec);
    const stages = listStages(parseBpXml(file.xml).root);
    const data = stages.find((stage) => stage.name === "Seed Data");
    assert(data);
    expect(data.type).toBe("Collection");
    expect(childText(data.element, "datatype")).toBe("collection");
    expect(firstChild(data.element, "private")).toBeDefined();
    expect(firstChild(data.element, "alwaysinit")).toBeDefined();
    const info = firstChild(data.element, "collectioninfo");
    const initial = firstChild(data.element, "initialvalue");
    assert(info && initial);
    const field = childElements(info)[0];
    assert(field);
    expect(field.attributes).toEqual([
      { name: "name", value: "CaseKey" },
      { name: "type", value: "text" },
    ]);
    expect(
      childElements(initial, "row").map((row) => {
        const item = childElements(row, "field")[0];
        assert(item);
        return {
          name: getAttr(item, "name"),
          type: getAttr(item, "type"),
          value: getAttr(item, "value"),
        };
      }),
    ).toEqual(spec.items.map((item) => ({ name: "CaseKey", type: "text", value: item.CaseKey })));
    expect(stages.find((stage) => stage.name === "Item IDs")?.type).toBe("Collection");
    expect(generateQueueSeed(spec).xml).toBe(file.xml);
  });

  it("emits the reflected native Add To Queue signature followed by a real count", () => {
    const root = parseBpXml(generateQueueSeed(spec).xml).root;
    const stages = listStages(root);
    const actions = stages.filter((stage) => stage.type === "Action");
    expect(actions).toHaveLength(2);
    const action = actions[0];
    assert(action);
    const resource = firstChild(action.element, "resource");
    const inputs = firstChild(action.element, "inputs");
    assert(resource && inputs);
    expect(resource.attributes).toEqual([
      { name: "object", value: "Blueprism.Automate.clsWorkQueuesActions" },
      { name: "action", value: "Add To Queue" },
    ]);
    expect(
      childElements(inputs).map((input) => [
        getAttr(input, "name"),
        getAttr(input, "type"),
        getAttr(input, "expr"),
      ]),
    ).toEqual([
      ["Queue Name", "text", "[Queue Name]"],
      ["Data", "collection", "[Seed Data]"],
      ["Defer Until", "datetime", ""],
      ["Priority", "number", "0"],
      ["Tags", "text", '"bpdev-v1"'],
      ["Status", "text", '"Pending"'],
      ["Batch Size", "number", "2"],
      ["SLA", "timespan", ""],
      ["SLA Deadline", "datetime", ""],
    ]);
    for (const input of childElements(inputs))
      expect(getAttr(input, "friendlyname")).toBe(getAttr(input, "name"));
    const outputs = firstChild(action.element, "outputs");
    assert(outputs);
    const output = childElements(outputs)[0];
    assert(output);
    expect(getAttr(output, "name")).toBe("Item IDs");
    expect(getAttr(output, "type")).toBe("collection");
    expect(getAttr(output, "stage")).toBe("Item IDs");
    expect(stages.some((stage) => ["Recover", "Resume", "LoopStart"].includes(stage.type))).toBe(
      false,
    );
    const end = stages.find((stage) => stage.type === "End");
    assert(end);
    const count = actions[1];
    assert(count);
    expect(action.onSuccess).toBe(count.id);
    expect(count.onSuccess).toBe(end.id);
    expect(childText(root, "narrative") ?? getAttr(root, "narrative")).toContain(
      "Replaying may duplicate",
    );
  });

  it("counts returned Item IDs by native collection name, never a preinitialized batch size", () => {
    const stages = listStages(parseBpXml(generateQueueSeed(spec).xml).root);
    const count = stages.find((stage) => stage.name === "Count Seeded Item IDs");
    const seedCount = stages.find((stage) => stage.name === "Seed Count");
    assert(count && seedCount);
    expect(childText(seedCount.element, "initialvalue")).toBe("0");
    const resource = firstChild(count.element, "resource");
    const inputs = firstChild(count.element, "inputs");
    const outputs = firstChild(count.element, "outputs");
    assert(resource && inputs && outputs);
    expect(getAttr(resource, "object")).toBe("Blueprism.AutomateProcessCore.clsCollectionActions");
    expect(getAttr(resource, "action")).toBe("Count Rows");
    expect(
      childElements(inputs).map((input) => [
        getAttr(input, "name"),
        getAttr(input, "friendlyname"),
        getAttr(input, "type"),
        getAttr(input, "expr"),
      ]),
    ).toEqual([["Collection Name", "Collection Name", "text", '"Item IDs"']]);
    expect(
      childElements(outputs).map((output) => [
        getAttr(output, "name"),
        getAttr(output, "friendlyname"),
        getAttr(output, "type"),
        getAttr(output, "stage"),
      ]),
    ).toEqual([["Count", "Count", "number", "Seed Count"]]);
    // Even a one-item spec must obtain its count from the action output.
    const single = listStages(
      parseBpXml(generateQueueSeed({ ...spec, items: [{ CaseKey: "one" }] }).xml).root,
    );
    const singleCount = single.find((stage) => stage.name === "Seed Count");
    assert(singleCount);
    expect(childText(singleCount.element, "initialvalue")).toBe("0");
  });

  it.each([1, 3, 20])("uses one strictly positive native batch for %i items", (size) => {
    const file = generateQueueSeed({
      ...spec,
      items: Array.from({ length: size }, (_, i) => ({ CaseKey: `case-${i}` })),
    });
    const action = listStages(parseBpXml(file.xml).root).find(
      (stage) => stage.name === "Seed Queue Once",
    );
    assert(action);
    const inputs = firstChild(action.element, "inputs");
    assert(inputs);
    const batchSize = childElements(inputs).find(
      (input) => getAttr(input, "name") === "Batch Size",
    );
    assert(batchSize);
    expect(getAttr(batchSize, "expr")).toBe(String(size));
  });

  it("requires a bounded, nonempty synthetic batch with unique keys", () => {
    for (const items of [
      [],
      Array.from({ length: 21 }, (_, i) => ({ CaseKey: String(i) })),
      [{ CaseKey: "same" }, { CaseKey: "same" }],
      [{ CaseKey: "" }],
      [{ CaseKey: "x".repeat(256) }],
    ]) {
      expect(() => generateQueueSeed({ ...spec, items })).toThrow(SpecValidationError);
    }
    expect(
      queueSeedSpecSchema.safeParse({ ...spec, items: [{ CaseKey: "one", Password: "secret" }] })
        .success,
    ).toBe(false);
  });
});
