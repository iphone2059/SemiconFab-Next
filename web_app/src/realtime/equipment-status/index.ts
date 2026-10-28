/**
 * Public entry of the FAB-scoped equipment status boundary.
 *
 * The boundary is split into three adjacent modules so each rule has exactly one
 * owner: protocol.ts (payload shape + Site/FAB scope identity), gate.ts (Server
 * Epoch + Sequence ordering) and stream.ts (SSE transport). Importers should use
 * the explicit module matching their dependency; this entry exists for consumers
 * that only need the boundary as a whole (e.g. type-only feature imports).
 */
export * from './protocol';
export * from './gate';
export * from './stream';
