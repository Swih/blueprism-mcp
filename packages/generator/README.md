# @bpdev/generator

Transforms a validated object specification into deterministic Blue Prism 7.5.1 XML.
Public entry points are `parseObjectSpec`, `generateObject`, `parseTestHarnessSpec` and
`generateTestHarness`, with schema types, typed errors and XPath construction helpers.

Supported features include private shared pages, conditional Attach, dynamic element
parameters, state-based Waits and test processes calling multiple business objects.
The Wait group end is serialized before its start so the native loader preserves the
condition position. Runtime flow is determined by stage links, not XML order.

Generate the RPA Challenge examples from the repository root after extracting a catalogue:

```powershell
npm run build
node packages/generator/examples/generate-rpa-demo.js
```

This writes two objects and two test processes into `.bpdev/generated/reference-style/`.
It does not import or run them. `BP_ROBOT_PROFILE_DIR` can select a prepared robot Chrome
profile containing the Blue Prism extension.

See [the IR contract](../../docs/05-ir.md) for inputs, expressions and validation rules, and
[the native validation results](../../docs/06-dynamic-spy.md) for observed behavior and limits.
Queue consumers, template adaptation and a public MCP server are subsequent work.
