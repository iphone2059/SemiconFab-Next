// R10 negative fixture: value-import cycle a -> b -> a.
import { bValue } from './b';

export function aValue(): string { return bValue(); }
