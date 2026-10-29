// R10 negative fixture: type-only-import cycle c -> d -> c must also fail.
import type { DType } from './d.ts';

export type CType = { d?: DType };
