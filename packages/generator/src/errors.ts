/** Base class of every error thrown by @bpdev/generator. */
export class GeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** One problem in a spec: where it is (`actions[1] "Set Field X" > steps[0] (write)`) and why. */
export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The spec is malformed (zod) or inconsistent with the catalogue or with itself. Lists every
 * problem found, not only the first one.
 */
export class SpecValidationError extends GeneratorError {
  constructor(
    /** `ObjectSpec` or `TestHarnessSpec`. */
    readonly spec: string,
    readonly issues: readonly SpecIssue[],
  ) {
    super(`Invalid ${spec}:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`);
  }
}

/**
 * Two items would get the same GUID. Blue Prism would then run the wrong stage ("Can't
 * execute stage", docs/01-spikes.md rule 7), so generation stops instead.
 */
export class DuplicateIdError extends GeneratorError {
  constructor(
    readonly id: string,
    /** The stable path the GUID was derived from. */
    readonly path: string,
  ) {
    super(`Duplicate GUID ${id} for "${path}": every stage, page and element needs its own`);
  }
}
