# Evidence Priority

When facts conflict, use this order:

1. Explicit user-observed runtime behavior and explicit corrections.
2. Reproduced tests, logs, errors, and measurements.
3. Current implementation and configuration.
4. Documentation and comments.
5. Model inference.

Do not overwrite an explicit observed fact with a source-code inference. If evidence conflicts, surface the conflict and investigate it.
