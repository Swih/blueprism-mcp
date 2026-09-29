import { getAttr, listStages, parseBpXml } from "@bpdev/model";
import { describe, expect, it } from "vitest";
import { generateObject, type StepSpec } from "../src/index.js";
import { catalog, descendants, exampleObject, OPTIONS } from "./helpers.js";

describe("native exception capture is opt-in by attribute presence", () => {
  it.each([undefined, false, true])(
    "saveScreenCapture=%s on explicit raise and Wait timeout",
    (saveScreenCapture) => {
      for (const kind of ["raise", "waitFor"] as const) {
        const spec = exampleObject();
        const exception = {
          type: "System Exception",
          detail: "Synthetic timeout",
          saveScreenCapture,
        };
        const element = spec.elements[0];
        if (!element) throw new Error("Missing fixture element");
        const step: StepSpec =
          kind === "raise"
            ? { kind, exception }
            : { kind, element: element.key, timeoutSeconds: 1, onTimeout: exception };
        spec.actions = [
          { name: "Failure", description: "", inputs: [], outputs: [], steps: [step] },
        ];
        const result = generateObject(spec, catalog, OPTIONS);
        const root = parseBpXml(result.xml).root;
        const exceptions = descendants(root, "exception");
        expect(exceptions).toHaveLength(1);
        expect(exceptions.map((e) => getAttr(e, "savescreencapture"))).toEqual([
          saveScreenCapture ? "yes" : undefined,
        ]);
        expect(result.xml).not.toContain('savescreencapture="no"');
        const raised = listStages(root).find((s) => s.type === "Exception");
        expect(raised?.onSuccess).toBeUndefined();
        expect(listStages(root).some((s) => s.type === "Recover" || s.type === "Resume")).toBe(
          false,
        );
      }
    },
  );
});
