/**
 * persistence-error.ts — leaf module for persistence-error vocabulary.
 *
 * No runtime dependencies. Imported by:
 *   - persistence-codec (decode failures)
 *   - persistence-migration (unsupported version)
 *   - durable-store (interface contract)
 *   - in-memory-durable-store / file-durable-store (backend errors)
 *
 * Decoder / migration / store error contracts MUST NOT depend on
 * the concrete store implementation module (P3-B LOCK §26). This
 * leaf module breaks the otherwise circular import surface.
 */

/**
 * PersistenceError discriminated union.
 *
 * `cause?: unknown` is allowed on `io` and `corrupt` because
 * underlying fs / JSON failures expose useful debug context
 * (ENOENT, SyntaxError, etc.) that is NOT user-facing UX. CLI
 * presentation belongs to P3-E.
 */
export type PersistenceError =
 | { readonly kind: "io"; readonly message: string; readonly cause?: unknown }
 | {
    readonly kind: "corrupt";
    readonly message: string;
    readonly cause?: unknown;
   }
 | {
    readonly kind: "unsupported-schema";
    readonly schemaVersion: number;
   }
 | {
    readonly kind: "migration";
    readonly fromVersion: number;
    readonly cause?: unknown;
   };
