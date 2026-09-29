import type { Catalog } from "@bpdev/catalog";
import { generatedFile, processElement } from "./document.js";
import { IdRegistry } from "./ids.js";
import {
  parseObjectSpec,
  parseTestHarnessSpec,
  type ObjectSpec,
  type TestHarnessSpec,
} from "./ir.js";
import { ROW, TOP_Y } from "./layout.js";
import { Page } from "./page.js";
import { resolveHarness } from "./resolve-harness.js";
import { resolveObject } from "./resolve-object.js";
import { actionBody, dataItemBody, endBody, rethrowBody } from "./stages.js";
import type { GeneratedHarness } from "./verify-harness.js";

const MAIN_PAGE = "Main Page";

/**
 * Generates the test process (`.bpprocess`) of a primary object, optionally calling other
 * supplied objects: it calls each action in order and
 * exposes expected outputs with an assertionManifest for verifyHarnessOutputs in the runner. Any
 * exception goes through Recover, the cleanup action (e.g. Terminate, so no browser is left
 * open), then rethrows while still in recovery mode. Every object spec is checked
 * against the catalogue too, so a harness is never generated for an object that cannot be.
 */
export function generateTestHarness(
  spec: TestHarnessSpec,
  objectSpec: ObjectSpec | readonly ObjectSpec[],
  catalog: Catalog,
): GeneratedHarness {
  const harness = parseTestHarnessSpec(spec);
  const specs: readonly ObjectSpec[] = Array.isArray(objectSpec)
    ? objectSpec
    : [objectSpec as ObjectSpec];
  const objects = specs.map(
    (object) => resolveObject(parseObjectSpec(object), catalog, undefined).spec,
  );
  const plan = resolveHarness(harness, objects);

  const ids = new IdRegistry();
  const preferredId = ids.id(plan.name);
  const page = new Page(ids, plan.name, MAIN_PAGE, undefined);
  page.info("ProcessInfo", "Info", "", []);
  page.main("Start", "Start", []);
  for (const call of plan.calls) {
    page.main(
      "Action",
      call.action.name,
      actionBody(call.object, call.action.name, call.inputs, call.outputs),
    );
  }
  page.main("End", "End", endBody(plan.outputs));
  for (const output of plan.outputs) page.data(output.name, dataItemBody(output.dataType));

  const recover = page.branch("Recover", "Recover", [], TOP_Y + ROW);
  const cleanup = page.branch(
    "Action",
    `${plan.cleanupAction} After Error`,
    actionBody(plan.cleanupObject, plan.cleanupAction, [], []),
  );
  const rethrow = page.branch("Exception", "Rethrow", rethrowBody());
  Page.link(recover, cleanup);
  Page.link(cleanup, rethrow);

  const steps = plan.calls
    .map((c) => (c.object === plan.object ? c.action.name : `${c.object}::${c.action.name}`))
    .join(", ");
  const cleanupName =
    plan.cleanupObject === plan.object
      ? plan.cleanupAction
      : `${plan.cleanupObject}::${plan.cleanupAction}`;
  const narrative =
    `Test harness of ${plan.object}: calls ${steps}. On any exception: Recover, ` +
    `${cleanupName}, then preserve and rethrow the exception without resuming.`;
  const root = processElement({ name: plan.name, narrative, preferredId }, page.stages);
  return {
    ...generatedFile(plan.name, root, "bpprocess"),
    assertions: plan.assertions,
    assertionManifest: { version: 1, processName: plan.name, assertions: plan.assertions },
  };
}
