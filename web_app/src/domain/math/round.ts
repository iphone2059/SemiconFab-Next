/** Declared float tolerance shared by the frozen Tour/Wafer timelines. */
export const ROUND_DIGITS = 6;

/** Round a value to ROUND_DIGITS decimals; fixtures and controllers compare at 6 decimals. */
export const round = (value: number, digits = ROUND_DIGITS): number =>
  Math.round(value * 10 ** digits) / 10 ** digits + 0;
