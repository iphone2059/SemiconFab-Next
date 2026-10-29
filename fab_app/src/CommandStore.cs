using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Fab.App;

/// <summary>
/// One durable command-journal event. This is the internal persisted representation; the SSE
/// payload exposes only fabId/commandId/revision/outcome/occurredAt. Site and command target
/// fields are persisted so a lost command record can be rebuilt from the journal (outbox
/// semantics, ADR-008 2.3 step 5) without resurrecting terminal commands that were pruned.
/// </summary>
public sealed record CommandJournalEvent(
    long Sequence,
    string SiteId,
    string FabId,
    string CommandId,
    string EquipmentId,
    string Action,
    int Revision,
    string Outcome,
    string OccurredAt);

/// <summary>
/// Durable authoritative command record (ADR-008 2.1). <see cref="Events"/> is the record's
/// own bounded journal history so the journal can be rebuilt after a crash between the record
/// write and the journal append.
/// </summary>
public sealed record CommandPersistedRecord(
    string SiteId,
    string FabId,
    string EquipmentId,
    string Action,
    string CommandId,
    int Revision,
    string Outcome,
    string CreatedAt,
    string OccurredAt,
    string? TerminalAt,
    CommandJournalEvent[] Events);

/// <summary>
/// Durable idempotency mapping: the scope hash identifies (site, FAB, principal, key) and the
/// entry carries the original accepted response so a replay after a restart returns exactly the
/// same commandId/revision/outcome/occurredAt.
/// </summary>
public sealed record CommandIdempotencyRecord(
    string Scope,
    string SiteId,
    string FabId,
    string EquipmentId,
    string Action,
    string CommandId,
    int Revision,
    string Outcome,
    string OccurredAt,
    string CreatedAt);

/// <summary>Pruning result persisted together with the durable journal rewrite (ADR-008 2.3 step 3).</summary>
public sealed record CommandRetentionUpdate(
    long FirstRetainedSequence,
    CommandJournalEvent[] RetainedEvents,
    string[] PrunedCommandIds,
    string[] PrunedIdempotencyScopes);

/// <summary>Fully recovered durable state of one Site. <see cref="Diagnostics"/> names every repair performed.</summary>
public sealed record CommandStoreRecovery(
    Guid Epoch,
    long FirstRetainedSequence,
    long LatestSequence,
    CommandJournalEvent[] Events,
    CommandPersistedRecord[] Records,
    CommandIdempotencyRecord[] Idempotency,
    string[] Diagnostics);

/// <summary>Durable command store. Every mutating call is flushed to disk before it returns.</summary>
public interface ICommandStore
{
    /// <summary>
    /// Loads and repairs one Site's durable state. Throws <see cref="CommandStoreException"/>
    /// when the store cannot be read (startup must fail; there is no memory fallback).
    /// </summary>
    CommandStoreRecovery Recover(Guid siteId);

    /// <summary>Durably commits an accepted command (record + idempotency + journal line) and returns the assigned event.</summary>
    CommandJournalEvent CommitAccepted(Guid siteId, CommandPersistedRecord record, CommandIdempotencyRecord idempotency);

    /// <summary>Durably commits an advanced command record and its journal line.</summary>
    CommandJournalEvent CommitAdvance(Guid siteId, CommandPersistedRecord record);

    /// <summary>Persists retention cursors, rewrites the retained journal window and deletes pruned records/idempotency entries.</summary>
    void CommitRetention(Guid siteId, CommandRetentionUpdate update);

    /// <summary>Deletes bounded idempotency entries that were evicted from the in-memory window.</summary>
    void DeleteIdempotency(Guid siteId, IReadOnlyCollection<string> scopes);
}

/// <summary>Durable command storage failure. Always surfaced; never silently degraded to memory.</summary>
public sealed class CommandStoreException : Exception
{
    public CommandStoreException(string message, Exception? innerException = null) : base(message, innerException)
    {
    }
}

/// <summary>Stable idempotency scope hashing shared by the store and the conversation service.</summary>
public static class CommandIdempotencyScope
{
    public static string Hash(Guid siteId, Guid fabId, string principal, string idempotencyKey) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Join("\n", "command-idempotency-v1", siteId.ToString("D"), fabId.ToString("D"), principal, idempotencyKey))));
}

/// <summary>Structural validation of a recovered command record; failures are diagnosed and never trusted.</summary>
internal static class CommandRecordValidation
{
    public static string? Error(CommandPersistedRecord record, Guid siteId)
    {
        if (!string.Equals(record.SiteId, siteId.ToString("D"), StringComparison.Ordinal)) return "siteId";
        if (!Guid.TryParse(record.FabId, out _)) return "fabId";
        if (!Guid.TryParse(record.CommandId, out _)) return "commandId";
        if (string.IsNullOrWhiteSpace(record.EquipmentId)) return "equipmentId";
        if (string.IsNullOrWhiteSpace(record.Action)) return "action";
        if (record.Revision is < 0 or > 2) return "revision";
        if (string.IsNullOrWhiteSpace(record.Outcome)) return "outcome";
        if (!DateTimeOffset.TryParse(record.CreatedAt, out _)) return "createdAt";
        if (!DateTimeOffset.TryParse(record.OccurredAt, out _)) return "occurredAt";
        if (record.TerminalAt is not null && !DateTimeOffset.TryParse(record.TerminalAt, out _)) return "terminalAt";
        if (record.Events is null) return "events";
        foreach (var journalEvent in record.Events)
        {
            if (journalEvent is null || journalEvent.Revision is < 0 or > 2 || journalEvent.Sequence < 0 ||
                !Guid.TryParse(journalEvent.FabId, out _) || !Guid.TryParse(journalEvent.CommandId, out _) ||
                !DateTimeOffset.TryParse(journalEvent.OccurredAt, out _) || string.IsNullOrWhiteSpace(journalEvent.Outcome))
                return "events";
        }
        return null;
    }
}

/// <summary>Shared internal JSON format of the durable command store.</summary>
internal static class CommandStoreJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}