// Original, versioned object specification for the synthetic target in site.js.
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const parameter = (name, type = "text") => ({ name, type, description: name });
export function serviceDeskObjects(suffix, url = "http://127.0.0.1:8931/") {
  const timeout = (detail) => ({ type: "System Exception", detail, saveScreenCapture: true });
  const wait = (element, name, extra = {}) => ({
    kind: "waitFor",
    element,
    name,
    timeoutSeconds: 12,
    onTimeout: timeout(`${name} failed; reconcile any submitted item before retrying.`),
    ...extra,
  });
  const button = {
    key: "submit",
    name: "Submit request",
    type: "WebButton",
    match: { wElementType: "BUTTON", wXPath: "//button[normalize-space(.)='Submit request']" },
  };
  const basic = {
    name: `BPDEV Service Desk - Basic Actions ${suffix}`,
    description: "Owns the dedicated browser and its lifecycle.",
    runMode: "Exclusive",
    application: {
      kind: "BrowserLaunch",
      name: "Service Desk",
      browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      url,
      extraArgs: ["--no-first-run", "--no-default-browser-check"],
    },
    elements: [button],
    actions: [
      {
        name: "Launch",
        description: "Launch once and wait for the form.",
        inputs: [],
        outputs: [],
        steps: [{ kind: "launch" }, wait("submit", "Wait for form")],
      },
      {
        name: "Terminate",
        description: "Close the owned browser.",
        inputs: [],
        outputs: [],
        steps: [{ kind: "close" }],
      },
    ],
  };
  const form = {
    name: `BPDEV Service Desk - Form ${suffix}`,
    description: "Label-based fields and confirmation; no random IDs or field indexes.",
    runMode: "Exclusive",
    application: {
      kind: "BrowserAttach",
      name: "Service Desk",
      parameters: { WindowTitle: "BPDEV Service Desk*" },
    },
    elements: [
      button,
      {
        key: "field",
        name: "Input by label",
        type: "WebTextEdit",
        match: { wElementType: "INPUT" },
        dynamic: ["wXPath"],
      },
      {
        key: "confirmation",
        name: "Confirmed request",
        type: "WebElement",
        match: { wElementType: "OUTPUT" },
        dynamic: ["wXPath"],
      },
    ],
    actions: [
      {
        name: "Attach",
        description: "Attach to the named demo window only.",
        published: false,
        inputs: [],
        outputs: [],
        steps: [
          {
            kind: "ensureAttached",
            args: { WindowTitle: quote("BPDEV Service Desk*"), ProcessName: quote("chrome") },
          },
        ],
      },
      {
        name: "Set Field",
        description: "Wait, write, wait for the exact value.",
        published: false,
        inputs: [parameter("Field XPath"), parameter("Value")],
        outputs: [],
        steps: [
          { kind: "callPage", page: "Attach" },
          wait("field", "Wait for field", { params: { wXPath: "[Field XPath]" } }),
          {
            kind: "write",
            element: "field",
            name: "Write field",
            params: { wXPath: "[Field XPath]" },
            value: "[Value]",
          },
          wait("field", "Wait for written value", {
            params: { wXPath: "[Field XPath]" },
            condition: "WebCheckValue",
            expected: "[Value]",
          }),
        ],
      },
      {
        name: "Submit Case",
        description: "Submit exactly once and read the correlated confirmation; no retry.",
        inputs: [parameter("CaseKey")],
        outputs: [parameter("Confirmation")],
        steps: [
          {
            kind: "callPage",
            page: "Set Field",
            inputs: {
              "Field XPath": quote(
                "//label[normalize-space(.)='Case reference']/following-sibling::input",
              ),
              Value: "[CaseKey]",
            },
          },
          {
            kind: "callPage",
            page: "Set Field",
            inputs: {
              "Field XPath": quote(
                "//label[normalize-space(.)='Display name']/following-sibling::input",
              ),
              Value: quote("Alice Demo"),
            },
          },
          wait("submit", "Wait for submit"),
          { kind: "act", element: "submit", action: "WebClick", name: "Submit once" },
          wait("confirmation", "Wait for case result", {
            params: {
              wXPath: `${quote("//output[normalize-space(.)='CONFIRMED:")} & [CaseKey] & ${quote("' or normalize-space(.)='REJECTED:")} & [CaseKey] & ${quote("']")}`,
            },
          }),
          {
            kind: "read",
            element: "confirmation",
            action: "WebGetText",
            into: "Confirmation",
            params: { wXPath: quote("//output") },
          },
        ],
      },
    ],
  };
  return [basic, form];
}
