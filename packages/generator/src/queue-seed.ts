import { generatedFile, processElement, type GeneratedFile } from "./document.js";
import { IdRegistry } from "./ids.js";
import { Page } from "./page.js";
import { parseQueueSpec, queueSeedSpecSchema, type QueueSeedSpec } from "./queue-spec.js";
import {
  addQueueCollection,
  addQueueData,
  CASE_FIELD,
  COLLECTIONS_OBJECT,
  WORK_QUEUES_OBJECT,
} from "./queue-stages.js";
import { actionBody, endBody, type Param } from "./stages.js";

/** Synthetic seed only. Re-running this process can add duplicates; never retry blindly. */
export function generateQueueSeed(value: QueueSeedSpec): GeneratedFile {
  const spec = parseQueueSpec(queueSeedSpecSchema, value, "QueueSeedSpec");
  const ids = new IdRegistry();
  const page = new Page(ids, spec.name, "Main Page", undefined);
  page.info(
    "ProcessInfo",
    "Info",
    "Adds this synthetic batch once. A queue key does not make seeding idempotent.",
    [],
  );
  page.main("Start", "Start", []);
  const inputs: (Param & { expression: string })[] = [
    { name: "Queue Name", dataType: "text", expression: "[Queue Name]" },
    { name: "Data", dataType: "collection", expression: "[Seed Data]" },
    { name: "Defer Until", dataType: "datetime", expression: "" },
    { name: "Priority", dataType: "number", expression: "0" },
    { name: "Tags", dataType: "text", expression: '"bpdev-v1"' },
    { name: "Status", dataType: "text", expression: '"Pending"' },
    // BP 7.5.1's native batching helper throws for zero; keep this bounded seed in one batch.
    { name: "Batch Size", dataType: "number", expression: String(spec.items.length) },
    { name: "SLA", dataType: "timespan", expression: "" },
    { name: "SLA Deadline", dataType: "datetime", expression: "" },
  ];
  page.main(
    "Action",
    "Seed Queue Once",
    actionBody(WORK_QUEUES_OBJECT, "Add To Queue", inputs, [
      { name: "Item IDs", dataType: "collection", into: "Item IDs" },
    ]),
  );
  // Count the actual returned IDs, not the requested batch. The native Collections
  // action accepts the collection's name as text, not a collection expression.
  page.main(
    "Action",
    "Count Seeded Item IDs",
    actionBody(
      COLLECTIONS_OBJECT,
      "Count Rows",
      [{ name: "Collection Name", dataType: "text", expression: '"Item IDs"' }],
      [{ name: "Count", dataType: "number", into: "Seed Count" }],
    ),
  );
  page.main("End", "End", endBody([{ name: "Seed Count", dataType: "number" }]));
  addQueueData(page, [
    { name: "Queue Name", dataType: "text", value: spec.queueName },
    { name: "Seed Count", dataType: "number", value: "0" },
  ]);
  addQueueCollection(page, ids, spec.name, "Seed Data", [CASE_FIELD], spec.items, -165);
  addQueueCollection(page, ids, spec.name, "Item IDs", [], [], -45);
  return generatedFile(
    spec.name,
    processElement(
      {
        name: spec.name,
        preferredId: ids.id(spec.name),
        narrative:
          "Original synthetic queue seed. Add To Queue once, no recover/retry. Replaying may duplicate items; reconcile uncertain runs before any rerun.",
      },
      page.stages,
    ),
    "bpprocess",
  );
}
