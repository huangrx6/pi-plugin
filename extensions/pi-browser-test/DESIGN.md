# Design — pi-browser-test 0.1.0

## Responsibility

This release owns the immutable business-level Test Spec validation boundary. It does not own capability grants, action planning, environment binding, resolver selection, browser execution, healing, run journals or authorization decisions.

## Data flow

```text
Test Spec JSON ── structural validator ── semantic validator ── fixture digest check
                                            │
Capability Registry ────────────────────────┘
                                            │
                                            ▼
                              canonical JSON + TestSpecHash
```

Invalid input never receives a hash. A hash therefore identifies a structurally and semantically valid Test Spec together with its declared fixture digests; it does not represent an execution grant.

## Modules

| Module | Authority |
| --- | --- |
| `schema/test-spec.schema.json` | Published Draft 2020-12 contract |
| `schema-validator.ts` | Dependency-free runtime enforcement of the frozen structural contract |
| `semantic-validator.ts` | TS-001 through TS-015 cross-reference and contract rules |
| `registry.ts` | Capability Registry boundary, output-schema lookup and closed-object enforcement; published contract in `schema/capability-registry.schema.json` |
| `fixture-validator.ts` | Local asset containment, readability and SHA-256 verification |
| `canonical.ts` | Schema-aware ordering and stable hash |
| `validator.ts` | Validation orchestration |
| `index.ts` | Pi command adapter (command + `browser_test` agent tool) sharing one runValidation path; a directory argument batches sibling `*.test-spec.json` files, non-recursive |

The core modules do not import Pi. The runtime adapter reads files explicitly named by the user or agent and only reports results.

## Frozen decisions

- `caseId` survives revisions; `testSpecId` identifies one immutable revision.
- Capability Contract versions are pinned; resolver versions are absent.
- ValueExpression has only literal, fixture and prior-step-output variants.
- Setup, steps and cleanup are ordered finite sequences.
- Probes are read-only Capability Contracts.
- Static fixtures are content-addressed.
- Canonicalization sorts set-semantic arrays and preserves lifecycle arrays.
- Cleanup uses its own closed JSON Schema object. This fixes the invalid extension pattern in the freeze candidate without changing its domain model.
- Contract-declared capability input keys are sanctioned vocabulary for the TS-015 secret scan; literal payload keys and raw credential values are never sanctioned.
- The command adapter falls back to stdout when the host session has no UI, so headless runs still report results.

## Next boundary

The next implementation unit may consume a validated Test Spec and derive Capability Grants. It must treat the hash as provenance, preserve actor and input constraints, and remain separate from final policy authorization. Browser resolution and Playwright compilation remain further downstream.
