import type { GeneratedFile } from "./document.js";
import { SpecValidationError } from "./errors.js";
import { parseObjectSpec, type ObjectSpec } from "./ir.js";
import { parseQueueSpec, queueConsumerSpecSchema, type QueueConsumerSpec } from "./queue-spec.js";
import { buildQueueTemplate } from "./queue-template.js";

/** Validate the supplied action contracts, then build the original native queue-loop template. */
export function generateQueueConsumer(
  value: QueueConsumerSpec,
  objectValue: ObjectSpec | readonly ObjectSpec[],
): GeneratedFile {
  const spec = parseQueueSpec(queueConsumerSpecSchema, value, "QueueConsumerSpec");
  const supplied: readonly ObjectSpec[] = Array.isArray(objectValue)
    ? objectValue
    : [objectValue as ObjectSpec];
  const objects = supplied.map(parseObjectSpec);
  if (new Set(objects.map((object) => object.name)).size !== objects.length) {
    throw new SpecValidationError("QueueConsumerSpec", [
      { path: "objects", message: "duplicate supplied object names" },
    ]);
  }
  const object = objects.find((candidate) => candidate.name === spec.call.object);
  const action = object?.actions.find((candidate) => candidate.name === spec.call.action);
  if (
    !object ||
    !action ||
    action.published === false ||
    action.inputs.length !== 1 ||
    action.inputs[0]?.name !== spec.call.input ||
    action.inputs[0].type !== "text" ||
    action.outputs.length !== 1 ||
    action.outputs[0]?.name !== spec.call.confirmationOutput ||
    action.outputs[0].type !== "text"
  ) {
    throw new SpecValidationError("QueueConsumerSpec", [
      {
        path: "call",
        message:
          "must reference a supplied public action with exactly the named text input and text confirmation output",
      },
    ]);
  }
  for (const role of ["launch", "cleanup"] as const) {
    const ref = spec[role];
    if (!ref) continue;
    const lifecycle = objects
      .find((candidate) => candidate.name === ref.object)
      ?.actions.find((candidate) => candidate.name === ref.action);
    if (
      !lifecycle ||
      lifecycle.published === false ||
      lifecycle.inputs.length !== 0 ||
      lifecycle.outputs.length !== 0
    ) {
      throw new SpecValidationError("QueueConsumerSpec", [
        {
          path: role,
          message: "must reference a supplied public action with no inputs or outputs",
        },
      ]);
    }
  }

  return buildQueueTemplate(spec);
}
