import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCatalog, type Catalog } from "./catalog.js";
import { CatalogFileError } from "./errors.js";

/** Where `npm run catalog:extract` writes the catalogue, relative to the repository root. */
export const DEFAULT_CATALOG_DIR = ".bpdev/catalog";
/** Output of `bpprobe catalog`. */
export const CATALOG_FILE = "catalog.json";
/** Output of `bpprobe apptypes`. */
export const APPTYPES_FILE = "apptypes.json";

/**
 * Loads and validates `catalog.json` and `apptypes.json` from a directory. Throws
 * `CatalogFileError` (missing, unreadable, not JSON) or `CatalogSchemaError` (wrong shape).
 */
export function loadCatalog(dir: string): Catalog {
  const catalogFile = join(dir, CATALOG_FILE);
  const appTypesFile = join(dir, APPTYPES_FILE);
  return createCatalog(readJson(catalogFile), readJson(appTypesFile), {
    catalog: catalogFile,
    appTypes: appTypesFile,
  });
}

function readJson(file: string): unknown {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CatalogFileError(
      `Cannot read ${file} (${reason}). Generate the catalogue with ` +
        "`npm run catalog:extract -w @bpdev/catalog` on a machine with Blue Prism installed.",
      file,
    );
  }
  try {
    return JSON.parse(content.replace(/^\uFEFF/, "")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CatalogFileError(`${file} is not valid JSON: ${reason}`, file);
  }
}
