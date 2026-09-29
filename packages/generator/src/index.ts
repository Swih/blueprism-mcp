export { BP_VERSION, type GeneratedFile } from "./document.js";
export { DuplicateIdError, GeneratorError, SpecValidationError, type SpecIssue } from "./errors.js";
export { generateTestHarness } from "./harness.js";
export {
  verifyHarnessOutputs,
  type GeneratedHarness,
  type HarnessGeneratedFile,
  type HarnessAssertionManifest,
  type HarnessAssertion,
  type HarnessOutput,
  type HarnessAssertionFailure,
  type HarnessAssertionResult,
  type HarnessVerification,
} from "./verify-harness.js";
export {
  actionSpecSchema,
  applicationSpecSchema,
  elementSpecSchema,
  exceptionSpecSchema,
  objectSpecSchema,
  paramSpecSchema,
  parseObjectSpec,
  parseTestHarnessSpec,
  stepSpecSchema,
  testHarnessSpecSchema,
  type ActionSpec,
  type ApplicationSpec,
  type ElementSpec,
  type ExceptionSpec,
  type ObjectSpec,
  type ParamSpec,
  type StepSpec,
  type TestHarnessSpec,
} from "./ir.js";
export { generateObject, type GenerateObjectOptions } from "./object.js";
export { harnessName } from "./resolve-harness.js";
export {
  assessXPath,
  xpathLiteral,
  xpathByAttribute,
  xpathByText,
  xpathByClassToken,
  xpathByLabel,
  type XPathIssue,
  type XPathIssueCode,
} from "./xpath.js";
export { generateQueueDefinition } from "./queue-definition.js";
export { generateQueueSeed } from "./queue-seed.js";
export { generateQueueConsumer } from "./queue-consumer.js";
export {
  queueDefinitionSpecSchema,
  queueSeedSpecSchema,
  queueConsumerSpecSchema,
  type QueueDefinitionSpec,
  type QueueSeedSpec,
  type QueueConsumerSpec,
} from "./queue-spec.js";
