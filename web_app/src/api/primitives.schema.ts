import { Schema } from 'effect';

export const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const finiteNumber = Schema.Number.check(Schema.isFinite());
export const nonNegativeInteger = finiteNumber.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
/** Wire timestamps preserve the source text and require a real calendar date plus an offset. */
export const offsetDateTime = Schema.String.check(Schema.makeFilter((value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return 'Expected ISO-8601 timestamp with offset';
  const year = parseInt(match[1], 10), month = parseInt(match[2], 10), day = parseInt(match[3], 10);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] || 'Invalid calendar date';
}));
