using System.Collections.Concurrent;
using System.Globalization;
using Fab.Site;

namespace Fab.App;

/// <summary>Request body for the development equipment command endpoint.</summary>
public sealed record EquipmentCommandRequest(string FabId, string EquipmentId, string Action);

/// <summary>Authoritative state of one simulated equipment command. Revisions 0/1/2 map to accepted/executing/succeeded.</summary>
public sealed record EquipmentCommandStatus(
    string SiteId,
    string FabId,
    string EquipmentId,
    string Action,
    string CommandId,
    int Revision,
    string Outcome,
    string OccurredAt);

/// <summary>SSE payload of the command.result topic; deliberately does not duplicate the command action.</summary>
public sealed record EquipmentCommandStreamPayload(string FabId, string CommandId, int Revision, string Outcome, string OccurredAt);

/// <summary>SSE envelope of the command.result topic.</summary>
public sealed record EquipmentCommandStreamEnvelope(string Topic, long Sequence, EquipmentCommandStreamPayload Payload);

public enum EquipmentCommandSubmitStatus
{
    Accepted,
    UnknownSite,
    UnknownFab,
    IdempotencyConflict
}

public sealed record EquipmentCommandSubmitResult(EquipmentCommandSubmitStatus Status, EquipmentCommandStatus? Command);

/// <summary>
/// Result of reading the command journal for one SSE connection. <see cref="HasGap"/> is true
/// when the client cursor cannot be served exactly (foreign/malformed epoch or pruned sequence)
/// and a replay-gap signal must be emitted before the retained events.
/// </summary>
public sealed record JournalReadResult(
    EquipmentCommandStreamEnvelope[] Events,
    bool HasGap,
    bool CursorAccepted,
    long RequestedSequence,
    long FirstRetainedSequence,
    long LatestSequence);

/// <summary>JSON body of the SSE <c>event: replay-gap</c> control frame (no id line, not journaled).</summary>
public sealed record CommandReplayGapDto(
    string Topic,
    bool ReplayGap,
    string Epoch,
    string? RequestedLastEventId,
    long FirstRetainedSequence,
    long LatestSequence,
    string OccurredAt);

/// <summary>Deterministic knobs for the development command simulation and its memory retention.</summary>
public sealed class EquipmentCommandOptions
{
    public TimeSpan ExecutingDelay { get; init; } = TimeSpan.FromMilliseconds(150);

    public TimeSpan SucceededDelay { get; init; } = TimeSpan.FromMilliseconds(600);

    public TimeSpan TerminalTtl { get; init; } = TimeSpan.FromMinutes(5);

    public int MaxTerminalCommands { get; init; } = 512;

    public int MaxJournalEventsPerSite { get; init; } = 4096;

    public int MaxIdempotencyEntries { get; init; } = 4096;
}

/// <summary>
/// Development-only, in-memory equipment command simulation. It gives the preview an
/// authoritative command lifecycle (accepted -> executing -> succeeded), deduplicates
/// command submissions by Idempotency-Key, keeps a replayable per-Site event journal with a
/// per-process cursor epoch, and bounds memory by pruning terminal commands. It is meant to
/// be replaced by a real SEMI E30/E40 command adapter later.
///
/// Active commands are always retained; terminal commands are pruned after
/// <see cref="EquipmentCommandOptions.TerminalTtl"/> and/or once more than
/// <see cref="EquipmentCommandOptions.MaxTerminalCommands"/> remain. Pruned commands are
/// removed from authoritative GET and from idempotency replay, so callers get a clean 404
/// and a retry after pruning creates a new command.
/// </summary>
public sealed class EquipmentCommandService
{
    public const string CommandResultTopic = "command.result";
    public const string AcceptedOutcome = "accepted";
    public const string ExecutingOutcome = "executing";
    public const string SucceededOutcome = "succeeded";
    public const int MaxEquipmentIdLength = 128;
    public const int MaxActionLength = 64;
    public const int MaxIdempotencyKeyLength = 128;
    public const int StreamPollMilliseconds = 50;

    private readonly SiteDirectory directory;
    private readonly TimeProvider clock;
    private readonly EquipmentCommandOptions options;
    private readonly ConcurrentDictionary<Guid, EquipmentCommandStatus> commands = new();
    private readonly ConcurrentDictionary<Guid, SiteCommandJournal> journals = new();
    private readonly object submitGate = new();
    private readonly Dictionary<IdempotencyScope, IdempotencyEntry> idempotentCommands = new();
    private readonly Queue<IdempotencyScope> idempotencyOrder = new();
    private readonly ConcurrentDictionary<Guid, DateTimeOffset> terminalSince = new();
    private readonly Queue<Guid> terminalOrder = new();

    public EquipmentCommandService(SiteDirectory directory, TimeProvider? clock = null, EquipmentCommandOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(directory);
        this.directory = directory;
        this.clock = clock ?? TimeProvider.System;
        this.options = options ?? new EquipmentCommandOptions();
        if (this.options.ExecutingDelay <= TimeSpan.Zero || this.options.SucceededDelay <= this.options.ExecutingDelay)
            throw new ArgumentOutOfRangeException(nameof(options), "ExecutingDelay must be positive and SucceededDelay must be greater than ExecutingDelay.");
        if (this.options.TerminalTtl <= TimeSpan.Zero || this.options.MaxTerminalCommands < 1 ||
            this.options.MaxJournalEventsPerSite < 1 || this.options.MaxIdempotencyEntries < 1)
            throw new ArgumentOutOfRangeException(nameof(options), "Retention options must be positive.");
    }

    public EquipmentCommandOptions Options => options;

    /// <summary>Cursor epoch of this process instance; it changes on reconnect across restarts.</summary>
    public Guid JournalEpoch { get; } = Guid.NewGuid();

    private sealed class SiteCommandJournal
    {
        public readonly object Gate = new();
        public readonly List<EquipmentCommandStreamEnvelope> Events = [];
        public long Sequence;
    }

    /// <summary>Idempotency scope: one logical command per (Site, FAB, principal, Idempotency-Key).</summary>
    private readonly record struct IdempotencyScope(Guid SiteId, Guid FabId, string Principal, string IdempotencyKey);

    private sealed record IdempotencyEntry(string EquipmentId, string Action, EquipmentCommandStatus Accepted);

    /// <summary>Validates only the request shape; Site/FAB membership is validated by <see cref="Submit"/>.</summary>
    public static bool TryValidate(EquipmentCommandRequest? request, out string error)
    {
        if (request is null)
        {
            error = "A command request body is required.";
            return false;
        }
        if (string.IsNullOrWhiteSpace(request.FabId))
        {
            error = "fabId is required.";
            return false;
        }
        if (string.IsNullOrWhiteSpace(request.EquipmentId) || request.EquipmentId.Length > MaxEquipmentIdLength)
        {
            error = $"equipmentId must be a non-empty string of at most {MaxEquipmentIdLength} characters.";
            return false;
        }
        if (string.IsNullOrWhiteSpace(request.Action) || request.Action.Length > MaxActionLength)
        {
            error = $"action must be a non-empty string of at most {MaxActionLength} characters.";
            return false;
        }
        error = "";
        return true;
    }

    /// <summary>
    /// Validates and trims the required Idempotency-Key request header. The trimmed value is
    /// the value used for deduplication, so retries with cosmetic whitespace still replay.
    /// </summary>
    public static bool TryValidateIdempotencyKey(string? rawKey, out string idempotencyKey, out string error)
    {
        idempotencyKey = rawKey?.Trim() ?? "";
        if (idempotencyKey.Length is 0 or > MaxIdempotencyKeyLength)
        {
            error = $"An Idempotency-Key header of 1..{MaxIdempotencyKeyLength} characters is required.";
            return false;
        }
        if (idempotencyKey.Any(char.IsControl))
        {
            error = "Idempotency-Key must not contain control characters.";
            return false;
        }
        error = "";
        return true;
    }

    /// <summary>Parses an SSE Last-Event-ID value of the form <c>{epoch}:{sequence}</c>.</summary>
    public static bool TryParseLastEventId(string? lastEventId, out Guid epoch, out long sequence)
    {
        epoch = Guid.Empty;
        sequence = 0;
        if (string.IsNullOrWhiteSpace(lastEventId)) return false;
        var value = lastEventId.Trim();
        var separator = value.IndexOf(':', StringComparison.Ordinal);
        if (separator <= 0 || separator == value.Length - 1) return false;
        if (!Guid.TryParse(value[..separator], out epoch)) return false;
        return long.TryParse(value[(separator + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out sequence) && sequence >= 0;
    }

    /// <summary>Returns the authoritative current state, or null for an unknown/pruned command id.</summary>
    public EquipmentCommandStatus? Get(Guid commandId)
    {
        lock (submitGate) PruneTerminalCommandsLocked();
        return commands.TryGetValue(commandId, out var status) ? status : null;
    }

    /// <summary>
    /// Validates Site/FAB membership, deduplicates retries by (Site, FAB, principal,
    /// Idempotency-Key), records revision 0 (accepted), and schedules the background
    /// simulation of revisions 1 (executing) and 2 (succeeded).
    ///
    /// A repeated key with an identical payload replays the original accepted response; a
    /// repeated key with a different payload is an idempotency conflict. The lookup, the
    /// conflict decision and the command creation happen inside one lock, so concurrent
    /// retries of the same key create exactly one command and one journaled lifecycle.
    /// </summary>
    public EquipmentCommandSubmitResult Submit(Guid siteId, EquipmentCommandRequest request, string principal, string idempotencyKey)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(principal);
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);

        if (!directory.TryGetSite(siteId, out _))
            return new(EquipmentCommandSubmitStatus.UnknownSite, null);
        if (!Guid.TryParse(request.FabId, out var fabId) || !directory.TryGetFab(siteId, fabId, out var fab))
            return new(EquipmentCommandSubmitStatus.UnknownFab, null);

        var scope = new IdempotencyScope(siteId, fab.Id, principal, idempotencyKey);
        lock (submitGate)
        {
            PruneTerminalCommandsLocked();
            if (idempotentCommands.TryGetValue(scope, out var existing))
            {
                return string.Equals(existing.EquipmentId, request.EquipmentId, StringComparison.Ordinal) &&
                       string.Equals(existing.Action, request.Action, StringComparison.Ordinal)
                    ? new(EquipmentCommandSubmitStatus.Accepted, existing.Accepted)
                    : new(EquipmentCommandSubmitStatus.IdempotencyConflict, null);
            }

            var commandId = Guid.NewGuid();
            var accepted = new EquipmentCommandStatus(
                siteId.ToString("D"),
                fab.Id.ToString("D"),
                request.EquipmentId,
                request.Action,
                commandId.ToString("D"),
                0,
                AcceptedOutcome,
                clock.GetUtcNow().ToString("O"));
            commands[commandId] = accepted;
            Append(siteId, accepted);
            idempotentCommands[scope] = new IdempotencyEntry(request.EquipmentId, request.Action, accepted);
            idempotencyOrder.Enqueue(scope);
            while (idempotencyOrder.Count > options.MaxIdempotencyEntries)
                idempotentCommands.Remove(idempotencyOrder.Dequeue());
            _ = SimulateAsync(siteId, commandId);
            return new(EquipmentCommandSubmitStatus.Accepted, accepted);
        }
    }

    /// <summary>
    /// Returns the journal events for a Site whose per-Site sequence is greater than
    /// <paramref name="sequenceExclusive"/>. Used for live polling after an initial replay.
    /// </summary>
    public EquipmentCommandStreamEnvelope[] ReadJournalSince(Guid siteId, long sequenceExclusive)
    {
        if (!journals.TryGetValue(siteId, out var journal)) return [];
        lock (journal.Gate)
        {
            return EventsAfter(journal.Events, sequenceExclusive);
        }
    }

    /// <summary>
    /// Resolves one SSE connection's starting point from its Last-Event-ID cursor. A fresh
    /// connection replays the retained journal without a gap; a foreign/malformed epoch or a
    /// cursor older than the retained journal reports <see cref="JournalReadResult.HasGap"/>.
    /// </summary>
    public JournalReadResult ReadJournal(Guid siteId, string? lastEventId)
    {
        if (!journals.TryGetValue(siteId, out var journal))
            return new([], false, false, 0, 1, 0);
        lock (journal.Gate)
        {
            var latest = journal.Sequence;
            var firstRetained = journal.Events.Count == 0 ? latest + 1 : journal.Events[0].Sequence;
            if (string.IsNullOrWhiteSpace(lastEventId))
                return new(EventsAfter(journal.Events, 0), false, false, 0, firstRetained, latest);
            if (!TryParseLastEventId(lastEventId, out var epoch, out var requested))
                return new(journal.Events.ToArray(), true, false, 0, firstRetained, latest);
            if (epoch != JournalEpoch)
                return new(journal.Events.ToArray(), true, false, requested, firstRetained, latest);
            if (requested < firstRetained - 1)
                return new(journal.Events.ToArray(), true, true, requested, firstRetained, latest);
            return new(EventsAfter(journal.Events, requested), false, true, requested, firstRetained, latest);
        }
    }

    /// <summary>Builds the replay-gap control-frame payload for a gapped journal read.</summary>
    public CommandReplayGapDto CreateReplayGap(JournalReadResult result, string? requestedLastEventId, DateTimeOffset? occurredAt = null)
    {
        ArgumentNullException.ThrowIfNull(result);
        return new CommandReplayGapDto(
            CommandResultTopic,
            true,
            JournalEpoch.ToString("D"),
            requestedLastEventId,
            result.FirstRetainedSequence,
            result.LatestSequence,
            (occurredAt ?? clock.GetUtcNow()).ToString("O"));
    }

    /// <summary>
    /// Prunes terminal commands past the configured TTL or beyond the configured terminal
    /// count. Pruning is also applied lazily on <see cref="Get"/> and <see cref="Submit"/>;
    /// this entry point makes it deterministic for tests.
    /// </summary>
    public int PruneTerminalCommands()
    {
        lock (submitGate) return PruneTerminalCommandsLocked();
    }

    private int PruneTerminalCommandsLocked()
    {
        var expiredBefore = clock.GetUtcNow() - options.TerminalTtl;
        var removed = 0;
        while (terminalOrder.Count > 0)
        {
            var commandId = terminalOrder.Peek();
            if (!terminalSince.TryGetValue(commandId, out var terminalAt))
            {
                terminalOrder.Dequeue();
                continue;
            }
            if (terminalOrder.Count <= options.MaxTerminalCommands && terminalAt > expiredBefore) break;
            terminalOrder.Dequeue();
            terminalSince.TryRemove(commandId, out _);
            if (commands.TryRemove(commandId, out _))
            {
                RemoveIdempotencyEntries(commandId);
                removed++;
            }
        }
        return removed;
    }

    private void RemoveIdempotencyEntries(Guid commandId)
    {
        var id = commandId.ToString("D");
        foreach (var pair in idempotentCommands.Where(pair => pair.Value.Accepted.CommandId == id).ToArray())
            idempotentCommands.Remove(pair.Key);
    }

    private static EquipmentCommandStreamEnvelope[] EventsAfter(List<EquipmentCommandStreamEnvelope> journal, long sequenceExclusive)
    {
        var start = 0;
        while (start < journal.Count && journal[start].Sequence <= sequenceExclusive) start++;
        return start == journal.Count ? [] : journal.GetRange(start, journal.Count - start).ToArray();
    }

    private async Task SimulateAsync(Guid siteId, Guid commandId)
    {
        try
        {
            await Task.Delay(options.ExecutingDelay).ConfigureAwait(false);
            Advance(siteId, commandId, 1, ExecutingOutcome);
            await Task.Delay(options.SucceededDelay - options.ExecutingDelay).ConfigureAwait(false);
            Advance(siteId, commandId, 2, SucceededOutcome);
        }
        catch
        {
            // Development-only simulation: background transitions must never surface as request failures.
        }
    }

    private void Advance(Guid siteId, Guid commandId, int revision, string outcome)
    {
        if (!commands.TryGetValue(commandId, out var current)) return;
        var next = current with
        {
            Revision = revision,
            Outcome = outcome,
            OccurredAt = clock.GetUtcNow().ToString("O")
        };
        commands[commandId] = next;
        Append(siteId, next);
        if (revision != 2) return;
        lock (submitGate)
        {
            terminalSince[commandId] = clock.GetUtcNow();
            terminalOrder.Enqueue(commandId);
            PruneTerminalCommandsLocked();
        }
    }

    private void Append(Guid siteId, EquipmentCommandStatus status)
    {
        var journal = journals.GetOrAdd(siteId, _ => new SiteCommandJournal());
        lock (journal.Gate)
        {
            journal.Sequence++;
            journal.Events.Add(new EquipmentCommandStreamEnvelope(
                CommandResultTopic,
                journal.Sequence,
                new EquipmentCommandStreamPayload(status.FabId, status.CommandId, status.Revision, status.Outcome, status.OccurredAt)));
            if (journal.Events.Count > options.MaxJournalEventsPerSite)
                journal.Events.RemoveRange(0, journal.Events.Count - options.MaxJournalEventsPerSite);
        }
    }
}
