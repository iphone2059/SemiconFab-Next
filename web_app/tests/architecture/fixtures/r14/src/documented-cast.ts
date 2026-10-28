// R14 positive fixture: a cast with an attached justification comment is allowed.
// Justification: fixture proves documented as-unknown-as casts pass the gate.
export const documented = { value: 1 } as unknown as { value: 2 };
