# bpdev

Tooling that lets an LLM build Blue Prism 7.5.1 business objects and processes. The LLM
decides; typed, tested code writes the Blue Prism XML (`.bpprocess`, `.bpobject`,
`.bprelease`). The binding contract is [docs/04-architecture.md](docs/04-architecture.md); the
verified format rules are in [docs/01-spikes.md](docs/01-spikes.md).

## Layout

```
packages/
  model/     @bpdev/model   Lossless Blue Prism XML document (parse <-> serialize) + typed views
tools/
  bpprobe/                  C# read-only probe of the Blue Prism install (catalog, validate...)
docs/                       Scoping, spikes, architecture contract
spikes/                     Throwaway proofs (history, not shipped)
```

Planned next: `catalog`, `generator`, `bridge` (see the contract).

## Checks

Node 24 (see `.nvmrc`), npm workspaces.

```sh
npm install
npm run lint        # ESLint (typescript-eslint) + Prettier check
npm run typecheck   # tsc on every package, tests included
npm test            # Vitest
npm run build       # tsc -b (project references) into packages/*/dist
npm run format      # Prettier write
```

CI (`.github/workflows/ci.yml`) runs install, lint, typecheck and test on `windows-latest`.

Blue Prism integration tests (import, run, native validation) are opt-in with
`BP_INTEGRATION=1` and never run in CI. Credentials come from the environment, never from
the repository.
