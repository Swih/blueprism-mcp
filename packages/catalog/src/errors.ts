/** Base class of every error thrown by @bpdev/catalog. */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A catalogue file is missing, unreadable or not JSON. */
export class CatalogFileError extends CatalogError {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
  }
}

/** The JSON does not have the shape `bpprobe catalog` / `bpprobe apptypes` produce. */
export class CatalogSchemaError extends CatalogError {
  constructor(
    /** What was being read: a file path or a label such as `catalog JSON`. */
    readonly source: string,
    /** One line per problem, `path: message`. */
    readonly issues: readonly string[],
  ) {
    super(`Invalid ${source}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}
