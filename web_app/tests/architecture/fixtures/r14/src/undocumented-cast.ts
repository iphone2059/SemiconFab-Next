// R14 negative fixture: an undocumented 'as unknown as' cast must fail.

export const undocumented = { value: 1 } as unknown as { value: 2 };
