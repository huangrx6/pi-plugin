# Sources used for Pi integration shape

Implementation was aligned to Pi's documented extension/package concepts current during development:

- Extension lifecycle and `before_agent_start`, `tool_call`, `model_select`, commands:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Package manifest and local package install:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>

The extension intentionally avoids importing Pi package namespaces so it is less sensitive to namespace changes between Pi distributions/releases.

## Current-agent context (0.33)

The Pi extension lifecycle documentation confirms that `before_agent_start` runs before the agent loop's message events, while `context` runs after the user message has been emitted and immediately before each LLM call. The extension therefore calls `ctx.modelRegistry.complete` from `context`, uses `ctx.ui.setWorkingMessage` for the host-owned Working row, validates the result, and composes the normal turn. `before_provider_request` appends the selected block to the provider payload. Core logic still imports no Pi namespace.

The same lifecycle boundary lets an interrupted run perform another model recognition pass while comparing it with the saved decision. When `recognition.policyUnchanged` is true, the saved policy block and activity fingerprint are reused; `before_provider_request` still performs payload-level idempotence for each real model request.

Live recognition is model-only: the current host model is the default, while an explicitly configured endpoint supports OpenAI-compatible and Anthropic transports. Failed live recognition blocks the turn; deterministic classification is limited to offline preview and structural safety checks.
