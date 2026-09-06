# Test Spec Schema v1.0

Status: implemented freeze candidate.

## Purpose

Test Spec is the long-lived source of truth for business test semantics. It records what to test, which logical actor is required, fixed fixtures, business preconditions, ordered capability calls, expected business values and cleanup obligations.

It does not record browser mechanics, environment bindings, resolver versions, locators, run state, healing state, arbitrary executable code, raw secrets, risk overrides or authorization decisions.

```text
Test Spec
  ↓
Capability Grant
  ↓
Action Plan
  ↓
Capability Resolution Lock
  ↓
Deterministic Compiler
  ↓
Browser runner
```

## Identity and revision

- `caseId` is the permanent test-case identity.
- `testSpecId` identifies one immutable Test Spec revision.
- `revision` increases monotonically within one case.
- A non-initial revision should point to its predecessor through `parentTestSpecId`.
- Business-semantic changes require a revision: contract version, actor requirement, fixture digest, business input, assertion, precondition, setup, cleanup or ordered step sequence.
- Browser, locator, resolver, runner, retry, deployment and environment changes do not require a Test Spec revision.

## Model

```text
TestSpec
├── identity: schemaVersion, testSpecId, caseId, revision, parentTestSpecId
├── intent: title, intent, description, tags
├── actors
├── fixtures
├── preconditions
├── setup
├── steps
├── assertions
└── cleanup
```

Actors name logical role requirements. Credentials, cookies, tokens and storage state are resolved later by an authentication broker and never appear in the specification.

Fixtures are immutable local assets. Every fixture carries a SHA-256 digest, and validation checks the actual bytes before producing `TestSpecHash`.

Capability inputs use exactly one `ValueExpression` variant:

- `literal`: a finite JSON value;
- `fixtureRef`: one declared fixture;
- `stepOutputRef`: one prior step and a JSON Pointer into its Contract output.

Setup, steps and cleanup are finite ordered sequences of Capability Invocations. v1.0 has no loop, branch, recursion, dynamic capability selection or generated step.

Preconditions support `ACTOR_AUTHENTICATED` and read-only `CAPABILITY_ASSERTION`. Assertions read either a completed step output or a read-only capability result. `within` is an ISO-8601 business deadline; polling remains a runner decision.

Cleanup uses `ALWAYS`, `ON_SUCCESS` or `ON_FAILURE`, defaulting to `ALWAYS`. Cleanup receives no safety exemption and should identify resources through exact prior-step outputs.

## Predicate operators

The v1.0 operator set is frozen:

```text
EQUALS  NOT_EQUALS
GREATER_THAN  GREATER_THAN_OR_EQUAL  LESS_THAN  LESS_THAN_OR_EQUAL
CONTAINS  NOT_CONTAINS  MATCHES
EXISTS  NOT_EXISTS
IS_TRUE  IS_FALSE
IS_EMPTY  NOT_EMPTY
```

Comparison, containment and matching operators require `expected`. Existence, boolean and emptiness operators do not accept it. Custom expressions and scripts are forbidden.

## Capability Contracts

Every invocation pins `capabilityId` and `contractVersionId`. Resolver and backend choices remain downstream. Contract effects and organization risk floors cannot be lowered by the Test Spec.

Action positions should reference `ACTION`. Preconditions and assertion probes must reference `QUERY` with `sideEffect=NONE` and `externalEffect=NONE`.

## Canonicalization

Object keys use stable lexical ordering. Lifecycle arrays preserve source order. Set-semantic arrays use these rules:

| Field | Canonical order |
| --- | --- |
| `actors` | `actorId` |
| `fixtures` | `fixtureId` |
| `preconditions` | `preconditionId` |
| `tags` | lexical value |

Only these exact top-level paths are sets. Arrays inside Literal values retain their original order.

## Validation

The published [JSON Schema](schema/test-spec.schema.json) validates the closed structure. The semantic validator additionally enforces:

| Rule | Requirement |
| --- | --- |
| TS-001 | IDs are unique; setup, steps and cleanup share one Step namespace |
| TS-002 | Every `actorRef` exists |
| TS-003 | Every `fixtureRef` exists |
| TS-004 | Step outputs are available at the reference lifecycle point |
| TS-005 | Capability ID and Contract version form a registered pair |
| TS-006 | Capability input exists and is type/value compatible |
| TS-007 | Referenced output JSON Pointer exists in the Contract |
| TS-008 | Predicate and expected value match the source type |
| TS-009 | `expected` presence matches the operator |
| TS-010 | Cleanup follows the same contract and safety checks as other actions |
| TS-011 | Action and Query positions use the correct Capability kind |
| TS-012 | Probe capabilities have no side effect or external effect |
| TS-013 | Resolver, browser, environment, locator and executable fields are absent |
| TS-014 | Risk and policy decisions cannot be self-declared |
| TS-015 | Raw secret material is absent. Input keys declared by the referenced Capability Contract count as sanctioned business vocabulary; raw `Bearer`/`Basic` material stays forbidden everywhere |

Fixture validation additionally rejects paths outside the specification directory, unreadable files and digest mismatches.

## Freeze boundary

v1.0 intentionally excludes parameterized cases, controlled branches, composed specs and cross-case dependencies. Those require a future Schema version. They cannot be introduced through generic `script`, `expression`, `eval`, SQL or shell fields.
