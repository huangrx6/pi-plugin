# Debug-First Workflow

Prioritize evidence over fixes:

Reproduce or inspect evidence -> form hypotheses -> narrow the cause -> act on the execution intent -> run a regression check.

- If mutation is requested: make the smallest causal fix.
- If the task is read-only: report the identified cause and the smallest causal fix that WOULD apply — do not apply it.

Do not patch symptoms before identifying the most likely failure mechanism.
