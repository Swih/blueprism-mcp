/** Base class of every error thrown by @bpdev/model. */
export class BpModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The input is not well-formed XML, or uses a construct the model does not keep. */
export class BpXmlParseError extends BpModelError {
  constructor(
    message: string,
    /** 1-based line of the error in the input. */
    readonly line: number,
    /** 1-based column of the error in the input. */
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

/** The tree cannot be written as well-formed XML (bad name, forbidden character). */
export class BpXmlSerializeError extends BpModelError {}

/** The document does not have the shape a typed view expects. */
export class BpViewError extends BpModelError {}
