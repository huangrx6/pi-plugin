# Sources used for Pi integration shape

Implementation was aligned to Pi's documented extension/package concepts current during development:

- Extension lifecycle and `before_agent_start`, `tool_call`, `model_select`, commands:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Package manifest and local package install:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>

The extension intentionally avoids importing Pi package namespaces so it is less sensitive to namespace changes between Pi distributions/releases.

## Current-agent context (0.29)

The installed `@earendil-works/pi-coding-agent` 0.85.0 lifecycle documentation confirms that `before_agent_start` runs before the normal model turn, can update `ctx.ui.setStatus`, and can extend its system prompt. Current-agent interpretation therefore calls `ctx.modelRegistry.complete` during the preflight phase, updates the status while waiting, validates the result, and then composes the normal turn. Core logic still imports no Pi namespace.
