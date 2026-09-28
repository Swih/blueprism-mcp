import { v5 as uuidv5 } from "uuid";
import { DuplicateIdError } from "./errors.js";

/** Namespace of every bpdev GUID (uuid v5). Changing it changes every generated id. */
export const BPDEV_NAMESPACE = "8f3a52c6-1d47-4b8e-9c0a-6e2b7d15f4a9";

/**
 * Issues deterministic GUIDs: uuid v5 of a stable path such as
 * `object/page/stageType/stageName` (G6). Each path may be issued once per document; a
 * second request, or two paths that hash to the same GUID, throws `DuplicateIdError` rather
 * than letting Blue Prism run the wrong stage.
 */
export class IdRegistry {
  private readonly issued = new Map<string, string>();

  id(...parts: readonly string[]): string {
    // Escape "/" so that ("a/b", "c") and ("a", "b/c") stay distinct paths.
    const path = parts.map((p) => p.replaceAll("%", "%25").replaceAll("/", "%2F")).join("/");
    const id = uuidv5(path, BPDEV_NAMESPACE);
    if (this.issued.has(id)) throw new DuplicateIdError(id, path);
    this.issued.set(id, path);
    return id;
  }
}
