# Changelog

## 0.2.0 - 2026-09-06

- Emit command results to stdout in headless sessions (`pi -p`, JSON mode) instead of dropping them silently; hard failures now report at `error` level.
- Treat Capability Contract-declared input keys as sanctioned vocabulary for TS-015, so business fields such as `tokenCount` or `cookieConsent` validate; raw `Bearer`/`Basic` material and undeclared secret-looking keys stay rejected.
- Search parent directories for the default `.pi/browser-test/capability-registry.json` and explain the search when nothing is found.
- Name the missing or malformed file and its role (Test Spec vs Capability Registry) in load errors.
- Report semantic and fixture issues in one pass and validate the Test Spec structure once per run.
- Stop TS-008 from double-reporting an `expected` already flagged by TS-009, and suppress TS-007 cascades behind a TS-001 duplicate step ID.
- Stream fixture SHA-256 digests instead of buffering whole files, and reject fixtures whose symlink target escapes the Test Spec directory.
- Resolve output paths through `additionalProperties` schemas in open output contracts instead of rejecting them as TS-007.
- Fail closed on empty capability registries with a dedicated REGISTRY error, and report a non-object `inputSchema` once instead of twice.
- Accept `--registry=<path>` and a `help` (`--help`) action in `/browser-test`.
- Accept a directory of sibling `*.test-spec.json` files in `validate` and `hash`, reporting a per-file summary without aborting on the first failure.
- Reject Capability Schema nodes that combine `x-pi-valueKind` with other keywords instead of silently prioritizing it.
- Compute the canonical form once per validation and derive the hash from it instead of walking the spec twice.
- Align `notify` levels with the host API (`info`/`warning`/`error`); the previous `success` level was not part of the contract.

## 0.1.0 - 2026-09-06

- Publish Test Spec Schema v1.0 as a closed JSON Schema Draft 2020-12 artifact.
- Add dependency-free structural validation and TS-001 through TS-015 semantic validation against a Capability Registry.
- Verify fixture path containment, readability and SHA-256 digests before producing a hash.
- Add schema-aware canonicalization and stable `TestSpecHash` generation.
- Add `/browser-test validate` and `/browser-test hash` read-only commands, examples and regression tests.
