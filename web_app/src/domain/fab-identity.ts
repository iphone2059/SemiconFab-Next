/**
 * Canonical composite FAB identity (ADR-007 §3). A FAB is identified by
 * (siteId, fabId); fabId alone is NOT unique across sites and must never be used
 * as a map key or to infer a site.
 *
 * Map/Set keys are produced only by fabIdentityKey(): two components cannot
 * collide because JSON.stringify escapes separators inside the values (no
 * string concatenation with ':' or '\\u0000' may be used instead).
 */
export interface FabIdentity {
  readonly siteId: string;
  readonly fabId: string;
}

/** Unique, collision-free key for a composite FAB identity. */
export function fabIdentityKey(identity: FabIdentity): string {
  return JSON.stringify([identity.siteId, identity.fabId]);
}
