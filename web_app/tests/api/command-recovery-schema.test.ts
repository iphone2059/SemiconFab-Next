import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_DIRTY_REASONS,
  COMMAND_STATUS_FILTERS,
  DEFAULT_COMMAND_JOURNAL_LIMIT,
  MAX_COMMAND_JOURNAL_LIMIT,
  commandDirtySchema,
  commandJournalPageSchema,
  commandJournalQuerySchema,
  commandListQuerySchema,
  commandRecoveryListSchema,
  commandRecoverySchema,
  decodeCommandDirty,
  decodeCommandJournalPage,
  decodeCommandRecoveryList,
  type CommandDirtyWireAligned,
  type CommandJournalPageWireAligned,
  type CommandRecoveryListWireAligned,
} from '@/api/command-recovery.schema';
import type {
  CommandDirtyDto,
  CommandJournalPageDto,
  CommandRecoveryListDto,
} from '@/generated/contracts.generated';

/**
 * Boundary contract for the ADR-008 Phase D recovery endpoints. The wire types are generated from
 * contracts/json-schema/contracts.schema.json; these tests pin the decoded shapes, the enum/limit
 * rules and the alignment with the generated TypeScript DTOs.
 */

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAB_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const OCCURRED_AT = '2026-10-27T00:00:00.0000000+00:00';

const recovery = {
  siteId: SITE_ID,
  fabId: FAB_ID,
  commandId: COMMAND_ID,
  revision: 2,
  outcome: 'succeeded',
  occurredAt: OCCURRED_AT,
  terminal: true,
} as const;
const journalEvent = {
  sequence: 3,
  fabId: FAB_ID,
  commandId: COMMAND_ID,
  revision: 2,
  outcome: 'succeeded',
  occurredAt: OCCURRED_AT,
} as const;
const recoveryList = { epoch: '22222222-2222-4222-8222-222222222222', latestSequence: 3, commands: [recovery] };
const journalPage = {
  epoch: '22222222-2222-4222-8222-222222222222',
  hasGap: false,
  firstRetainedSequence: 1,
  latestSequence: 3,
  events: [journalEvent],
};
const dirty = {
  reason: 'retention-trim',
  droppedCount: 2,
  epoch: '22222222-2222-4222-8222-222222222222',
  sequence: 5,
  occurredAt: OCCURRED_AT,
};

const decodeList = (value: unknown) => Schema.decodeUnknownSync(commandRecoveryListSchema)(value);
const decodeListEffect = (value: unknown) => Effect.runPromise(decodeCommandRecoveryList(value));
const decodePageEffect = (value: unknown) => Effect.runPromise(decodeCommandJournalPage(value));
const decodeDirtyEffect = (value: unknown) => Effect.runPromise(decodeCommandDirty(value));
const decodePage = (value: unknown) => Schema.decodeUnknownSync(commandJournalPageSchema)(value);
const decodeDirty = (value: unknown) => Schema.decodeUnknownSync(commandDirtySchema)(value);

describe('command recovery wire contracts', () => {
  it('decodes every authoritative recovery DTO without changing the payload', () => {
    expect(decodeList(recoveryList)).toEqual(recoveryList);
    expect(decodePage(journalPage)).toEqual(journalPage);
    expect(decodeDirty(dirty)).toEqual(dirty);
    expect(Schema.decodeUnknownSync(commandRecoverySchema)(recovery)).toEqual(recovery);
  });

  it('keeps the decoded shapes assignable to the generated TypeScript DTOs', () => {
    // The declarations below only compile while the Effect schemas stay structurally aligned with
    // the generated wire DTOs; the tuple spreads only relax readonly array element types.
    const decodedList = decodeList(recoveryList);
    const alignedList: CommandRecoveryListDto = { ...decodedList, commands: [...decodedList.commands] };
    const decodedPage = decodePage(journalPage);
    const alignedPage: CommandJournalPageDto = { ...decodedPage, events: [...decodedPage.events] };
    const decodedDirty = decodeDirty(dirty);
    const alignedDirty: CommandDirtyDto = { ...decodedDirty };
    const listAlignment: CommandRecoveryListWireAligned = true;
    const pageAlignment: CommandJournalPageWireAligned = true;
    const dirtyAlignment: CommandDirtyWireAligned = true;
    expect([listAlignment, pageAlignment, dirtyAlignment]).toEqual([true, true, true]);
    expect(alignedList.commands[0].terminal).toBe(true);
    expect(alignedPage.events[0].sequence).toBe(3);
    expect(alignedDirty.reason).toBe('retention-trim');
  });

  it('rejects a recovery entry with a missing or wrongly typed field', () => {
    for (const field of ['siteId', 'fabId', 'commandId', 'revision', 'outcome', 'occurredAt', 'terminal']) {
      const candidate: Record<string, unknown> = { ...recoveryList, commands: [{ ...recovery }] };
      delete (candidate.commands as Record<string, unknown>[])[0][field];
      expect(() => decodeList(candidate), field).toThrow();
    }
    for (const override of [
      { revision: '2' },
      { revision: -1 },
      { revision: 1.5 },
      { outcome: 'success' },
      { terminal: 'true' },
      { occurredAt: '2026-10-27T00:00:00' },
      { commandId: 42 },
      { siteId: '' },
    ]) {
      expect(() => decodeList({ ...recoveryList, commands: [{ ...recovery, ...override }] }), JSON.stringify(override)).toThrow();
    }
  });

  it('rejects journal pages with invalid sequences, gaps or event fields', () => {
    for (const override of [
      { sequence: -1 },
      { sequence: '3' },
      { revision: -2 },
      { outcome: 'rejected' },
      { occurredAt: 'not-a-date' },
      { fabId: 42 },
    ]) {
      expect(() => decodePage({ ...journalPage, events: [{ ...journalEvent, ...override }] }), JSON.stringify(override)).toThrow();
    }
    expect(() => decodePage({ ...journalPage, hasGap: 'no' })).toThrow();
    expect(() => decodePage({ ...journalPage, firstRetainedSequence: -1 })).toThrow();
    expect(() => decodePage({ ...journalPage, latestSequence: '3' })).toThrow();
  });

  it('accepts terminal failed/cancelled outcomes and rejects unknown dirty reasons', () => {
    for (const outcome of ['accepted', 'executing', 'succeeded', 'failed', 'cancelled']) {
      expect(decodePage({ ...journalPage, events: [{ ...journalEvent, outcome }] }).events[0].outcome).toBe(outcome);
    }
    for (const reason of COMMAND_DIRTY_REASONS) {
      expect(decodeDirty({ ...dirty, reason }).reason).toBe(reason);
    }
    expect(() => decodeDirty({ ...dirty, reason: 'backpressure' })).toThrow();
    expect(() => decodeDirty({ ...dirty, droppedCount: -1 })).toThrow();
  });

  it('validates the listing and journal query parameter contract', () => {
    expect(COMMAND_STATUS_FILTERS).toEqual(['active', 'terminal', 'all']);
    for (const status of COMMAND_STATUS_FILTERS) {
      expect(Schema.decodeUnknownSync(commandListQuerySchema)({ status }).status).toBe(status);
    }
    expect(Schema.decodeUnknownSync(commandListQuerySchema)({}).status).toBeUndefined();
    expect(Schema.decodeUnknownSync(commandListQuerySchema)({ afterRevision: -1 }).afterRevision).toBe(-1);
    expect(() => Schema.decodeUnknownSync(commandListQuerySchema)({ status: 'finished' })).toThrow();
    expect(() => Schema.decodeUnknownSync(commandListQuerySchema)({ afterRevision: -2 })).toThrow();

    expect(Schema.decodeUnknownSync(commandJournalQuerySchema)({}).limit).toBeUndefined();
    expect(Schema.decodeUnknownSync(commandJournalQuerySchema)({ afterSequence: 0, limit: 1 }).limit).toBe(1);
    expect(Schema.decodeUnknownSync(commandJournalQuerySchema)({ limit: MAX_COMMAND_JOURNAL_LIMIT }).limit)
      .toBe(MAX_COMMAND_JOURNAL_LIMIT);
    expect(DEFAULT_COMMAND_JOURNAL_LIMIT).toBe(100);
    for (const limit of [0, -1, MAX_COMMAND_JOURNAL_LIMIT + 1, 1.5]) {
      expect(() => Schema.decodeUnknownSync(commandJournalQuerySchema)({ limit }), String(limit)).toThrow();
    }
  });

  it('decodes effectfully and fails on malformed server payloads', async () => {
    await expect(decodeListEffect(recoveryList)).resolves.toEqual(recoveryList);
    await expect(decodePageEffect(journalPage)).resolves.toEqual(journalPage);
    await expect(decodeDirtyEffect(dirty)).resolves.toEqual(dirty);
    await expect(decodeListEffect({ ...recoveryList, commands: [{}] })).rejects.toBeDefined();
    await expect(decodePageEffect({ ...journalPage, events: null })).rejects.toBeDefined();
    await expect(decodeDirtyEffect({ ...dirty, epoch: '' })).rejects.toBeDefined();
  });
});