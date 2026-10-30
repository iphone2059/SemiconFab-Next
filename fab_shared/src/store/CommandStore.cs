using System.Security.Cryptography;
using System.Text;

namespace Fab.Contracts;

/// <summary>
/// One durable command-journal event (SQLite <c>journal</c> row). The SSE payload exposes only
/// fabId/commandId/revision/outcome/occurredAt; the command target lives in the transactional
/// command record (ADR-012 2.1). Sequence is assigned inside the submit/advance transaction.
/// </summary>
public sealed record CommandJournalEvent(
    long Sequence,
    string FabId,
    string CommandId,
    int Revision,
    string Outcome,
    string OccurredAt);

/// <summary>Durable authoritative command record (ADR-012 2.1, SQLite <c>commands</c> row).</summary>
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
    string? TerminalAt);

/// <summary>
/// Durable idempotency/outbox entry (ADR-012 2.1, SQLite <c>idempotency</c> row). The primary key
/// is (site, FAB, principal, key); <see cref="ResponseJson"/> is the original accepted response so
/// a replay after a restart returns exactly the same commandId/revision/outcome/occurredAt.
/// </summary>
public sealed record CommandIdempotencyRecord(
    string SiteId,
    string FabId,
    string Principal,
    string Key,
    string RequestHash,
    string CommandId,
    string ResponseJson,
    string CreatedAt);

/// <summary>Outcome of one transactional submit attempt (ADR-012 2.2).</summary>
public enum CommandStoreSubmitStatus
{
    /// <summary>The command/idempotency/journal/site-state transaction committed.</summary>
    Accepted,
    /// <summary>The same idempotency key + payload already committed; the stored response must be replayed.</summary>
    Replayed,
    /// <summary>The same idempotency key was used with a different payload (HTTP 409).</summary>
    PayloadMismatch,
    /// <summary>
    /// The target FAB already holds the configured maximum number of durable active commands
    /// (<c>revision &lt; 2</c>); nothing was inserted (HTTP 429). Idempotency replay of an
    /// already-committed command is decided before this check and therefore still succeeds.
    /// </summary>
    CapacityExceeded
}

/// <summary>
/// Result of a transactional submit: <see cref="Event"/> is set when a new command committed.
/// <see cref="ActiveCommands"/> is the durable active-command count observed by the admission
/// check (set on <see cref="CommandStoreSubmitStatus.CapacityExceeded"/>, zero otherwise).
/// </summary>
public sealed record CommandStoreSubmitResult(
    CommandStoreSubmitStatus Status,
    CommandJournalEvent? Event = null,
    CommandPersistedRecord? Command = null,
    CommandIdempotencyRecord? Idempotency = null,
    int ActiveCommands = 0);

/// <summary>
/// Retention transaction input (ADR-012 2.2): delete the pruned commands together with their
/// idempotency/outbox rows and journal events, and drop retained-window journal rows below
/// <see cref="FirstRetainedSequence"/>. All deletions and the cursor advance commit atomically.
/// </summary>
public sealed record CommandRetentionUpdate(long FirstRetainedSequence, string[] PrunedCommandIds);

/// <summary>Fully recovered durable state of one Site. <see cref="Diagnostics"/> names recovery actions.</summary>
public sealed record CommandStoreRecovery(
    Guid Epoch,
    long FirstRetainedSequence,
    long LatestSequence,
    CommandJournalEvent[] Events,
    CommandPersistedRecord[] Records,
    CommandIdempotencyRecord[] Idempotency,
    string[] Diagnostics);

/// <summary>
/// Transactional durable command store (ADR-012). Every mutation commits as exactly one database
/// transaction; there is no window in which a command exists without its idempotency entry and
/// accepted journal event. Reads may return the last committed state only.
/// </summary>
public interface ICommandStore
{
    /// <summary>
    /// Loads one Site's committed durable state (single transaction snapshot). Throws
    /// <see cref="CommandStoreException"/> when the store is unavailable, inconsistent or
    /// unreadable: startup must fail, there is no memory fallback.
    /// </summary>
    CommandStoreRecovery Recover(Guid siteId);

    /// <summary>
    /// Atomically commits one accepted command: unique idempotency insert (or replay/conflict
    /// lookup) + command row + accepted journal event + site-state epoch/latest advance.
    ///
    /// Admission (R4-08): <paramref name="maxActiveCommandsPerFab"/> bounds the number of durable
    /// active commands (<c>revision &lt; 2</c>) for the target (Site, FAB). The count runs inside
    /// the same write transaction as the insert, immediately before it, so two concurrent
    /// submissions cannot both observe a below-bound count and commit: a service-level pre-count
    /// outside the transaction would be a check-then-act race and is therefore rejected as the
    /// enforcement point. Replay/conflict is decided first, so retrying an already-accepted
    /// command never fails on capacity (it creates nothing new). A non-positive bound is a
    /// programming error and throws <see cref="ArgumentOutOfRangeException"/> before any write.
    /// </summary>
    CommandStoreSubmitResult CommitSubmit(Guid siteId, CommandPersistedRecord command,
        CommandIdempotencyRecord idempotency, int maxActiveCommandsPerFab);

    /// <summary>
    /// Atomically advances a command revision: revision guard + command update + journal event +
    /// site-state latest advance. Returns null when the command is unknown or already at/past the
    /// requested revision (idempotent no-op).
    /// </summary>
    CommandJournalEvent? CommitAdvance(Guid siteId, string commandId, int expectedRevision, int revision,
        string outcome, string occurredAt, string? terminalAt);

    /// <summary>Atomically prunes commands/idempotency/journal events and persists the retention cursor.</summary>
    void CommitRetention(Guid siteId, CommandRetentionUpdate update);
}

/// <summary>Durable command storage failure. Always surfaced; never silently degraded to memory.</summary>
public sealed class CommandStoreException : Exception
{
    public CommandStoreException(string message, Exception? innerException = null) : base(message, innerException)
    {
    }
}

/// <summary>Stable request-payload hash for idempotency conflict detection (same key + different payload).</summary>
public static class CommandRequestHash
{
    public static string Compute(Guid siteId, Guid fabId, string equipmentId, string action) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Join("\n", "command-idempotency-payload-v1", siteId.ToString("D"), fabId.ToString("D"), equipmentId, action))));
}
