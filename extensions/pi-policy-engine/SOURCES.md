# Sources used for Pi integration shape

Implementation was aligned to Pi's documented extension/package concepts current during development:

- Extension lifecycle and `before_agent_start`, `tool_call`, `model_select`, commands:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Package manifest and local package install:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>

The extension intentionally avoids importing Pi package namespaces so it is less sensitive to namespace changes between Pi distributions/releases.

## Active model reuse (0.28)

Checked against the installed `@earendil-works/pi-coding-agent` 0.85.0: `docs/extensions.md` (ctx.modelRegistry / ctx.model), `examples/extensions/qna.ts`, and `dist/core/model-registry.d.ts`. The documented `ctx.modelRegistry.complete(ctx.model, context, { signal })` delegates to the host runtime and resolves provider/auth configuration there. The integration uses feature detection and an injected callable; core logic still imports no Pi namespace.
