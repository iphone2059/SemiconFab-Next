// R10 negative fixture: value-import cycle a -> b -> a.
import { aValue } from './a.ts';

export function bValue(): string { return aValue(); }
