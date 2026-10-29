/** Compile-only positive/negative checks of the native Schema/HTTP boundary. */
import { Effect, Option, Schema } from 'effect';
import type { CatalogPageDto, CreateRunRequest, RunResult, RunSummary, SiteDto } from '@/contracts/app-contracts';
import { catalogPageSchema } from '@/api/catalog.schema';
import { createRunRequestSchema, runListSchema, runResultSchema, runSummarySchema } from '@/api/runs.schema';
import { sitesSchema } from '@/api/sites.schema';
import { submittedEquipmentCommandSchema, type SubmittedEquipmentCommand } from '@/api/command.schema';
import { createHttpTransport, decodeApiResponse, type ApiError } from '@/api/http.transport';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import { submitEquipmentCommand } from '@/api/commands.mutation';
import type { CommandResultEvent } from '@/contracts/command-events.contract';

declare const catalog: typeof catalogPageSchema.Type;
declare const run: typeof runSummarySchema.Type;
declare const runs: typeof runListSchema.Type;
declare const results: typeof runResultSchema.Type;
declare const request: typeof createRunRequestSchema.Type;
declare const sites: typeof sitesSchema.Type;
export const wireContracts: [CatalogPageDto, RunSummary, RunSummary[], RunResult, CreateRunRequest, SiteDto[]] =
  [catalog, run, runs, results, request, sites];
export const http: Effect.Effect<unknown, ApiError, never> = createHttpTransport().fetchJson('/api/v1/sites');
// ADR-008 §2.4: the authoritative recovery gateway is Promise-based; the
// composition root injects the approved Effect runner for wire decoding.
export const gateway: Promise<CommandResultEvent | null> = createHttpCommandGateway({
  runPromise: (effect) => Effect.runPromise(effect),
}).getCommandStatus('fab', 'cmd');
// @ts-expect-error The gateway never exposes an Effect-shaped status query.
export const gatewayEffect: Effect.Effect<Option.Option<CommandResultEvent>, ApiError, never> = gateway;
export const submission: Effect.Effect<SubmittedEquipmentCommand, ApiError, never> = submitEquipmentCommand({
  siteId: 'site', fabId: 'fab', equipmentId: 'tool', action: 'START', idempotencyKey: 'stable',
});
export const decoded = Schema.decodeUnknownEffect(submittedEquipmentCommandSchema)({});
// @ts-expect-error API failures must remain in the typed channel.
export const erasedFailure: Effect.Effect<unknown, never> = http;
// @ts-expect-error HTTP Effects do not expose a Promise API at the native boundary.
export const promise: Promise<unknown> = http;
// @ts-expect-error Command outcomes retain their finite protocol union.
export const invalidOutcome: SubmittedEquipmentCommand['outcome'] = 'unknown';
declare const requiresService: Effect.Effect<string, ApiError, { readonly service: 'required' }>;
// @ts-expect-error An unresolved service cannot be executed by a no-context runner.
Effect.runPromise(requiresService);
declare const serviceSchema: Schema.ConstraintDecoder<string, { readonly service: 'required' }>;
// @ts-expect-error A service-dependent decoder cannot enter the no-service HTTP decoder boundary.
decodeApiResponse(serviceSchema, 'invalid');
