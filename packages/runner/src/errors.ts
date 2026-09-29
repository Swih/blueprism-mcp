/** Public errors exclude raw tool output, XML, filesystem paths and causes. */
export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}
