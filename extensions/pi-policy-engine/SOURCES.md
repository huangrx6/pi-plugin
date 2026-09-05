# Sources used for Pi integration shape

Implementation was aligned to Pi's documented extension/package concepts current during development:

- Extension lifecycle and `before_agent_start`, `tool_call`, `model_select`, commands:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Package manifest and local package install:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>

The extension intentionally avoids importing Pi package namespaces so it is less sensitive to namespace changes between Pi distributions/releases.

## Current-agent context (0.29)

The installed `@earendil-works/pi-coding-agent` 0.85.0 lifecycle documentation confirms that `before_agent_start` runs before the normal model turn and can extend its system prompt. Current-agent interpretation therefore uses an injected contextual policy in the existing turn. It does not call `modelRegistry.complete`; this avoids blocking message display and lets the model use the conversation already supplied by the host. Core logic still imports no Pi namespace.
