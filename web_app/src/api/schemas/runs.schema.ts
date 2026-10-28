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
  createdAtUtc: z.string().min(1),
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

/** Validate run submissions before they leave the browser, using generated contracts. */
const fabScenarioSchema: z.ZodType<FabScenario> = z.object({
  fabId: z.string().min(1),
  code: z.string().min(1),
  lotCount: z.number().int().positive(),
  processTimeUs: z.string().regex(/^\\d+$/),
});

const scenarioDefinitionSchema: z.ZodType<ScenarioDefinition> = z.object({
  contractVersion: z.literal(1),
  siteId: z.string().min(1),
  mode: z.string().min(1),
  masterSeed: z.string().min(1),
  durationUs: z.string().regex(/^\\d+$/),
  warmupUs: z.string().regex(/^\\d+$/),
  fabs: z.array(fabScenarioSchema).min(1),
});

export const createRunRequestSchema: z.ZodType<CreateRunRequest> = z.object({
  scenario: scenarioDefinitionSchema,
});
