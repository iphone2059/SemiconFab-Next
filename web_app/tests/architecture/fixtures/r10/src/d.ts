// R10 negative fixture: type-only-import cycle c -> d -> c must also fail.
import type { CType } from './c';

export type DType = { c?: CType };
