# Observability Policy

All production-impacting changes must update or extend observability in the same change.

- Preserve log field names; adding new fields is fine, renaming or removing is breaking.
- Error propagation: do not swallow errors silently to make a path look clean.
- New external calls must declare a metric or trace point before being merged.
- Health checks and SLI definitions are part of the operational contract and follow the same compatibility rules as APIs.
