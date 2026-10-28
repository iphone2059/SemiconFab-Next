import { z } from 'zod';
import type { CreateRunRequest, FabScenario, RunResult, RunSummary, FabExecutionSummary, FabSimulationResult, SimulationEventDto, ScenarioDefinition } from '../../contracts';

/**
 * The generated .NET wire contracts are authoritative. This is the single runtime
 * decoder for list/detail/create/results; unknown nested records may not enter Query.
 */
const executionSchema: z.ZodType<FabExecutionSummary> = z.object({
  fabId: z.string().min(1),
  code: z.string().min(1),
  status: z.string().min(1),
  completedLots: z.string(),
  totalLots: z.string(),
  simulationTimeUs: z.string(),
  traceHash: z.string().nullable(),
  error: z.string().nullable(),
});

export const runSummarySchema: z.ZodType<RunSummary> = z.object({
  runId: z.string().min(1),
  siteId: z.string().min(1),
  status: z.string().min(1),
  version: z.string().min(1),
  createdAtUtc: z.iso.datetime({ offset: true }),
  executions: z.array(executionSchema),
});

export const runListSchema: z.ZodType<RunSummary[]> = z.array(runSummarySchema);

const simulationEventSchema: z.ZodType<SimulationEventDto> = z.object({
  fabId: z.string().min(1),
  entityId: z.string().min(1),
  kind: z.string().min(1),
  simulationTimeUs: z.string(),
  sequence: z.string(),
});

const fabResultSchema: z.ZodType<FabSimulationResult> = z.object({
  fabId: z.string().min(1),
  completedLots: z.string(),
  totalLots: z.string(),
  simulationTimeUs: z.string(),
  busyTimeUs: z.string(),
  traceHash: z.string(),
  events: z.array(simulationEventSchema),
});

export const runResultSchema: z.ZodType<RunResult> = z.object({
  runId: z.string().min(1),
  fabs: z.array(fabResultSchema),
});

/** Follow FabSimulation.Validate in fab_shared; no legacy/coerced wire values. */
const uuidD = z.string().regex(/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/)
  .refine((value) => value.replaceAll('-', '') !== '00000000000000000000000000000000', 'UUID must be nonzero');
const uint64Max = 18446744073709551615n;
const int64Max = 9223372036854775807n;
const isCanonicalDecimal = (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20;
const decimal = (limit: bigint, positive: boolean) => z.string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(20)
  .refine((value) =>
    isCanonicalDecimal(value) &&
    BigInt(value) <= limit &&
    (!positive || BigInt(value) > 0n), 'Decimal exceeds its wire range');

const fabScenarioSchema: z.ZodType<FabScenario> = z.object({
  fabId: uuidD,
  code: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  lotCount: z.number().int().min(1).max(10000),
  processTimeUs: decimal(int64Max, true),
});

const scenarioDefinitionSchema: z.ZodType<ScenarioDefinition> = z.object({
  contractVersion: z.literal(1),
  siteId: uuidD,
  mode: z.literal('INDEPENDENT'),
  masterSeed: decimal(uint64Max, false),
  durationUs: decimal(int64Max, true),
  warmupUs: decimal(int64Max, false),
  fabs: z.array(fabScenarioSchema).min(1).max(32),
}).superRefine((scenario, ctx) => {
  if (isCanonicalDecimal(scenario.warmupUs) && isCanonicalDecimal(scenario.durationUs) &&
      BigInt(scenario.warmupUs) >= BigInt(scenario.durationUs))
    ctx.addIssue({ code: 'custom', path: ['warmupUs'], message: 'Warmup must precede duration' });
  const ids = new Set<string>();
  const codes = new Set<string>();
  scenario.fabs.forEach((fab, index) => {
    const id = fab.fabId.toLowerCase(), code = fab.code.toLowerCase();
    if (ids.has(id)) ctx.addIssue({ code: 'custom', path: ['fabs', index, 'fabId'], message: 'Duplicate FAB ID' });
    if (codes.has(code)) ctx.addIssue({ code: 'custom', path: ['fabs', index, 'code'], message: 'Duplicate FAB code' });
    ids.add(id);
    codes.add(code);
    if (isCanonicalDecimal(fab.processTimeUs) && Number.isInteger(fab.lotCount) &&
        fab.lotCount > 0 && (BigInt(fab.processTimeUs) + BigInt(fab.processTimeUs) / 10n) * BigInt(fab.lotCount) > int64Max)
      ctx.addIssue({ code: 'custom', path: ['fabs', index, 'processTimeUs'], message: 'Worst-case completion exceeds Int64' });
  });
});

export const createRunRequestSchema: z.ZodType<CreateRunRequest> = z.object({
  scenario: scenarioDefinitionSchema,
});
