// R10 negative fixture: type-only-import cycle c -> d -> c must also fail.
import type { DType } from './d';

export type CType = { d?: DType };
