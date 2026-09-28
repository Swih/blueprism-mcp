export { BP_VERSION, type GeneratedFile } from "./document.js";
export { DuplicateIdError, GeneratorError, SpecValidationError, type SpecIssue } from "./errors.js";
export { generateTestHarness } from "./harness.js";
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
