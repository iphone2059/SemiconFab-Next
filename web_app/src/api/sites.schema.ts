import { Schema } from 'effect';
import { nonEmptyString } from '@/api/primitives.schema';
export const sitesSchema = Schema.Array(Schema.Struct({
  siteId: nonEmptyString, code: nonEmptyString, templateHash: Schema.String,
  fabs: Schema.Array(Schema.Struct({ fabId: nonEmptyString, code: nonEmptyString })).pipe(Schema.mutable).check(Schema.isMinLength(1)),
})).pipe(Schema.mutable);
export const decodeSites = Schema.decodeUnknownEffect(sitesSchema);
