import { el, textEl, type BpElement } from "@bpdev/model";
import type { ResolvedElement, ResolvedObject } from "./resolve-object.js";

/**
 * `<appdef>`: the application root element, typed `Application` (G1: otherwise `Launch`
 * throws a NullReferenceException), its elements, and `apptypeinfo` with every parameter of
 * the application type (G2: 7.5 BrowserLaunch has 5, `prelaunchbrowser` included).
 */
export function appDefinition(
  plan: ResolvedObject,
  applicationId: string,
  elementId: (key: string) => string,
): BpElement {
  return el("appdef", {}, [
    el("element", { name: plan.spec.application.name }, [
      textEl("id", applicationId),
      textEl("type", "Application"),
      textEl("basetype", "Application"),
      textEl("datatype", "unknown"),
      textEl("diagnose", "False"),
      ...plan.elements.map((e) => webElement(e, elementId(e.spec.key))),
    ]),
    el("apptypeinfo", {}, [
      textEl("id", plan.appType.id),
      el(
        "parameters",
        {},
        plan.appParameters.map((p) =>
          el("parameter", {}, [textEl("name", p.name), textEl("value", p.value)]),
        ),
      ),
    ]),
  ]);
}

/** A web element with every catalogue identifier, `inuse` only on the matching ones (G3). */
function webElement(element: ResolvedElement, id: string): BpElement {
  return el("element", { name: element.spec.name }, [
    textEl("id", id),
    textEl("type", element.type.id),
    textEl("basetype", element.type.id),
    textEl("datatype", element.type.defaultDataType || "text"),
    textEl("diagnose", "False"),
    el(
      "attributes",
      {},
      element.attributes.map((a) =>
        el(
          "attribute",
          {
            name: a.id,
            inuse: a.inUse ? "True" : undefined,
            comparisontype: a.dynamic ? "dynamic" : undefined,
            isUserVisible: a.userVisible ? "True" : undefined,
          },
          [el("ProcessValue", { datatype: a.dataType, value: a.value })],
        ),
      ),
    ),
  ]);
}
