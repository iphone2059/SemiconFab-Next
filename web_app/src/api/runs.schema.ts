import { Schema } from 'effect';
import { nonEmptyString, offsetDateTime } from '@/api/primitives.schema';

/**
 * The generated .NET wire contracts are authoritative. This is the single runtime
 * decoder for list/detail/create/results; unknown nested records may not enter Query.
 */
const executionSchema = Schema.Struct({
  fabId: nonEmptyString,
  code: nonEmptyString,
  status: nonEmptyString,
  completedLots: Schema.String,
  totalLots: Schema.String,
  simulationTimeUs: Schema.String,
  traceHash: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

export const runSummarySchema = Schema.Struct({
  runId: nonEmptyString,
  siteId: nonEmptyString,
  status: nonEmptyString,
  version: nonEmptyString,
  createdAtUtc: offsetDateTime,
  executions: Schema.Array(executionSchema).pipe(Schema.mutable),
});

export const runListSchema = Schema.Array(runSummarySchema).pipe(Schema.mutable);

const simulationEventSchema = Schema.Struct({
  fabId: nonEmptyString,
  entityId: nonEmptyString,
  kind: nonEmptyString,
  simulationTimeUs: Schema.String,
  sequence: Schema.String,
});

const fabResultSchema = Schema.Struct({
  fabId: nonEmptyString,
  completedLots: Schema.String,
  totalLots: Schema.String,
  simulationTimeUs: Schema.String,
  busyTimeUs: Schema.String,
  traceHash: Schema.String,
  events: Schema.Array(simulationEventSchema).pipe(Schema.mutable),
});

export const runResultSchema = Schema.Struct({
  runId: nonEmptyString,
  fabs: Schema.Array(fabResultSchema).pipe(Schema.mutable),
});

/** Follow FabSimulation.Validate in fab_shared; no legacy/coerced wire values. */
const uuidD = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/),
  Schema.makeFilter((value: string) => value.replaceAll('-', '') !== '00000000000000000000000000000000' || 'UUID must be nonzero'));
const uint64Max = 18446744073709551615n;
const int64Max = 9223372036854775807n;
const decimal = (limit: bigint, positive: boolean) => Schema.String.check(Schema.makeFilter((value: string) =>
  /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20 && BigInt(value) <= limit && (!positive || BigInt(value) > 0n)
    || 'Decimal exceeds its wire range'));

const fabScenarioSchema = Schema.Struct({
  fabId: uuidD,
  code: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  lotCount: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10000 })),
  processTimeUs: decimal(int64Max, true),
});

const scenarioDefinitionSchema = Schema.Struct({
  contractVersion: Schema.Literal(1),
  siteId: uuidD,
  mode: Schema.Literal('INDEPENDENT'),
  masterSeed: decimal(uint64Max, false),
  durationUs: decimal(int64Max, true),
  warmupUs: decimal(int64Max, false),
  fabs: Schema.Array(fabScenarioSchema).pipe(Schema.mutable).check(Schema.isBetweenLength(1, 32)),
}).check(Schema.makeFilter(scenario => {
  if (BigInt(scenario.warmupUs) >= BigInt(scenario.durationUs)) return 'Warmup must precede duration';
  const ids = new Set<string>(), codes = new Set<string>();
  for (const fab of scenario.fabs) {
    const id = fab.fabId.toLowerCase(), code = fab.code.toLowerCase();
    if (ids.has(id)) return 'Duplicate FAB ID';
    if (codes.has(code)) return 'Duplicate FAB code';
    ids.add(id); codes.add(code);
    if ((BigInt(fab.processTimeUs) + BigInt(fab.processTimeUs) / 10n) * BigInt(fab.lotCount) > int64Max)
      return 'Worst-case completion exceeds Int64';
  }
  return true;
}));

export const createRunRequestSchema = Schema.Struct({
  scenario: scenarioDefinitionSchema,
});

export const decodeRunSummary = Schema.decodeUnknownEffect(runSummarySchema);

export const decodeRunList = Schema.decodeUnknownEffect(runListSchema);

export const decodeRunResult = Schema.decodeUnknownEffect(runResultSchema);

export const decodeCreateRunRequest = Schema.decodeUnknownEffect(createRunRequestSchema);
