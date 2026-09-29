import { doc, el, serializeBpXml, textEl } from "@bpdev/model";
import type { GeneratedFile } from "./document.js";
import { IdRegistry } from "./ids.js";
import {
  parseQueueSpec,
  queueDefinitionSpecSchema,
  type QueueDefinitionSpec,
} from "./queue-spec.js";

/** Original queue-only release; native import/permissions are qualified by the runner. */
export function generateQueueDefinition(value: QueueDefinitionSpec): GeneratedFile {
  const spec = parseQueueSpec(queueDefinitionSpecSchema, value, "QueueDefinitionSpec");
  const ids = new IdRegistry();
  const root = el("bpr:release", { "xmlns:bpr": "http://www.blueprism.co.uk/product/release" }, [
    textEl("bpr:name", `${spec.name} - Queue Definition`),
    textEl(
      "bpr:release-notes",
      "Original bpdev v1 queue. One attempt; no automatic retry. Import only into an isolated test environment.",
    ),
    textEl(
      "bpr:created",
      new Date(spec.createdAt)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "Z"),
    ),
    textEl("bpr:package-id", "1"),
    textEl("bpr:package-name", `${spec.name} - Queue Package`),
    textEl("bpr:user-created-by", "bpdev"),
    el("bpr:contents", { count: "1" }, [
      el("work-queue", {
        xmlns: "http://www.blueprism.co.uk/product/work-queue",
        id: ids.id("queue", spec.name),
        name: spec.name,
        "key-field": spec.keyField,
        "max-attempts": String(spec.maxAttempts),
      }),
    ]),
  ]);
  const document = doc(root);
  return {
    name: spec.name,
    fileName: `${spec.name}.bprelease`,
    document,
    xml: serializeBpXml(document),
  };
}
