import { BpViewError } from "../errors.js";
import type { BpElement } from "../nodes.js";
import { firstChild, localName } from "../query.js";
import { requireAttr } from "./require.js";

/** A process or business object stored in a release. */
export interface ReleaseEntry {
  kind: "process" | "object";
  id: string;
  name: string;
  /** The `<process>` element itself: usable with the process views. */
  process: BpElement;
}

/**
 * Processes and objects in a `.bprelease` (`<bpr:release>` → `<bpr:contents>`), in document
 * order. Other contents (groups, queues…) are skipped. Elements are matched by local name,
 * whatever their prefix.
 */
export function listReleaseContents(root: BpElement): ReleaseEntry[] {
  if (localName(root.name) !== "release") {
    throw new BpViewError(`Expected a release element, got <${root.name}>`);
  }
  const contents = root.children.find(
    (c): c is BpElement => c.kind === "element" && localName(c.name) === "contents",
  );
  if (!contents) throw new BpViewError("The release has no contents element");
  const entries: ReleaseEntry[] = [];
  for (const entry of contents.children) {
    if (entry.kind !== "element") continue;
    const kind = localName(entry.name);
    if (kind !== "process" && kind !== "object") continue;
    const process = firstChild(entry, "process");
    if (!process) throw new BpViewError(`Release ${kind} entry has no <process> element`);
    entries.push({ kind, id: requireAttr(entry, "id"), name: requireAttr(entry, "name"), process });
  }
  return entries;
}
