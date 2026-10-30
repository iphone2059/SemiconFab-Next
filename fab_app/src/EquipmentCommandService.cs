using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Fab.Contracts;
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
    IdempotencyConflict,
    InvalidCommand,
    /// <summary>
    /// The target FAB already holds the configured number of active commands (revision &lt; 2). The
    /// command was not accepted, nothing was persisted and no simulation actor was created; the
    /// client must wait for an active command to reach a terminal revision (HTTP 429).
    /// </summary>
    ActiveCapacityExceeded,
    /// <summary>The durable store failed; the command was not persisted and must not be treated as accepted.</summary>
    StoreUnavailable
}

/// <summary>
/// Outcome of one submit attempt. <see cref="ActiveCommands"/> is the durable active-command count
/// observed by the admission check when <see cref="Status"/> is
/// <see cref="EquipmentCommandSubmitStatus.ActiveCapacityExceeded"/> (zero otherwise).
/// </summary>
public sealed record EquipmentCommandSubmitResult(
    EquipmentCommandSubmitStatus Status,
    EquipmentCommandStatus? Command,
    EquipmentCommandValidationResult? Validation = null,
    int ActiveCommands = 0);

/// <summary>
/// Result of reading the command journal for one SSE connection. <see cref="HasGap"/> is true
/// when the client cursor cannot be served exactly (foreign/malformed epoch, a pruned cursor,
/// a missing sequence inside the retained window or a cursor ahead of the journal) and a
/// replay-gap signal must be emitted before the retained events. Events are already filtered to
/// the requested FAB when a scope is supplied. <see cref="DroppedCount"/> reports how many
/// sequence numbers inside the requested range are not retained (used for the dirty signal).
/// </summary>
public sealed record JournalReadResult(
    EquipmentCommandStreamEnvelope[] Events,
    bool HasGap,
    bool CursorAccepted,
    long RequestedSequence,
    long FirstRetainedSequence,
    long LatestSequence,
    Guid Epoch,
    long DroppedCount = 0);

/// <summary>JSON body of the SSE <c>event: replay-gap</c> control frame (no id line, not journaled).</summary>
public sealed record CommandReplayGapDto(
    string Topic,
    bool ReplayGap,
    string Epoch,
    string? RequestedLastEventId,
    long FirstRetainedSequence,
    long LatestSequence,
    string OccurredAt);

/// <summary>
/// Result of one epoch-aware journal page request (ADR-010 3). Either a page is returned or the
/// requested epoch is stale, in which case the API must answer 409 journal-epoch-mismatch and the
/// client must reconcile authoritative command state instead of continuing by sequence alone.
/// </summary>
public sealed record CommandJournalPageResult(CommandJournalPageDto? Page, JournalEpochMismatch? EpochMismatch);

/// <summary>Body of the HTTP 409 <c>journal-epoch-mismatch</c> response.</summary>
public sealed record JournalEpochMismatch(Guid CurrentEpoch, long FirstRetainedSequence, long LatestSequence);

/// <summary>Deterministic knobs for the development command simulation and its durable retention.</summary>
public sealed class EquipmentCommandOptions
{
    /// <summary>Default per-FAB admission bound for active commands (revision &lt; 2).</summary>
    public const int DefaultMaxActiveCommandsPerFab = 64;

    /// <summary>Accepted upper bound for <see cref="MaxActiveCommandsPerFab"/>; larger values fail startup.</summary>
    public const int MaxActiveCommandsPerFabLimit = 4096;

    public TimeSpan ExecutingDelay { get; init; } = TimeSpan.FromMilliseconds(150);

    public TimeSpan SucceededDelay { get; init; } = TimeSpan.FromMilliseconds(600);

    public TimeSpan TerminalTtl { get; init; } = TimeSpan.FromMinutes(5);

    public int MaxTerminalCommands { get; init; } = 512;

    public int MaxJournalEventsPerSite { get; init; } = 4096;

    /// <summary>
    /// Per-FAB admission bound for active commands (revision &lt; 2): a brand-new command for a FAB
    /// that already holds this many active commands is rejected with
    /// <see cref="EquipmentCommandSubmitStatus.ActiveCapacityExceeded"/> before any durable write.
    /// The count is taken inside the durable submit transaction, terminal commands (revision 2) free
    /// capacity as soon as their revision commits, and an idempotent replay of an already-accepted
    /// command never consumes capacity because it creates nothing new.
    /// </summary>
    public int MaxActiveCommandsPerFab { get; init; } = DefaultMaxActiveCommandsPerFab;
}

/// <summary>
/// Development equipment command simulation backed by the transactional durable store (ADR-012).
/// It keeps an authoritative accepted -> executing -> succeeded lifecycle, deduplicates
/// submissions by (Site, FAB, principal, Idempotency-Key) through the store's unique constraint,
/// journals every event with a durable per-Site epoch/sequence, and persists terminal retention.
///
/// Every durable mutation the service performs is exactly one store transaction; the service only
/// mirrors committed state. A failed transaction raises the store fault and fails subsequent
/// submissions instead of silently degrading to memory.
///
/// Terminal commands are pruned after the configured TTL and/or beyond the terminal capacity;
/// their records, idempotency rows and journal events leave the retained window in the same
/// transaction, so their cursors report an explicit gap instead of a silent hole.
///
/// Admission (R4-08): every brand-new command is admitted only while the target FAB's durable
/// active-command count (revision &lt; 2) is below <see cref="EquipmentCommandOptions.MaxActiveCommandsPerFab"/>.
/// The count runs inside the same store transaction that inserts the command, so two concurrent
/// submissions can never both pass the check. The service deliberately keeps no separate admission
/// counter: the durable store is the authority (loaded at startup and after every prune), which is
/// what makes the bound survive restart instead of merely limiting one in-memory process.
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
    public const int DefaultJournalPageLimit = 100;
    public const int MaxJournalPageLimit = 1000;
    public const string StatusActive = "active";
    public const string StatusTerminal = "terminal";
    public const string StatusAll = "all";

    private static readonly JsonSerializerOptions StoreJson = new(JsonSerializerDefaults.Web);

    private readonly ICommandStore store;
    private readonly SiteDirectory directory;
    private readonly TimeProvider clock;
    private readonly EquipmentCommandOptions options;
    private readonly IEquipmentCommandValidator? validator;
    private readonly ConcurrentDictionary<Guid, SiteState> sites = new();
    private readonly ConcurrentDictionary<Guid, Guid> commandSites = new();
    private readonly ConcurrentDictionary<Guid, List<string>> recoveryDiagnostics = new();
    private CommandStoreException? storeFault;

    public EquipmentCommandService(
        ICommandStore store,
        SiteDirectory directory,
        TimeProvider? clock = null,
        EquipmentCommandOptions? options = null,
        IEquipmentCommandValidator? validator = null)
    {
        this.store = store ?? throw new ArgumentNullException(nameof(store));
        this.directory = directory ?? throw new ArgumentNullException(nameof(directory));
        this.clock = clock ?? TimeProvider.System;
        this.options = options ?? new EquipmentCommandOptions();
        this.validator = validator;
        if (this.options.ExecutingDelay <= TimeSpan.Zero || this.options.SucceededDelay <= this.options.ExecutingDelay)
            throw new ArgumentOutOfRangeException(nameof(options), "ExecutingDelay must be positive and SucceededDelay must be greater than ExecutingDelay.");
        if (this.options.TerminalTtl <= TimeSpan.Zero || this.options.MaxTerminalCommands < 1 ||
            this.options.MaxJournalEventsPerSite < 1)
            throw new ArgumentOutOfRangeException(nameof(options), "Retention options must be positive.");
        // Fail fast on an unusable admission bound instead of silently treating it as unlimited.
        if (this.options.MaxActiveCommandsPerFab is < 1 or > EquipmentCommandOptions.MaxActiveCommandsPerFabLimit)
            throw new ArgumentOutOfRangeException(nameof(options),
                $"MaxActiveCommandsPerFab must be between 1 and {EquipmentCommandOptions.MaxActiveCommandsPerFabLimit}.");
        // Fail fast: every configured Site is recovered before the API can serve a request, so an
        // unwritable/inconsistent store stops the process instead of silently degrading to memory.
        foreach (var site in directory.GetSites())
        {
            var siteId = Guid.Parse(site.SiteId);
            sites[siteId] = LoadSite(siteId);
        }
    }

    public EquipmentCommandOptions Options => options;

    /// <summary>True when a durable write failed; every subsequent write is refused explicitly.</summary>
    public bool StoreUnavailable => Volatile.Read(ref storeFault) is not null;

    /// <summary>Diagnostics collected by durable recovery (site-state creation, ...).</summary>
    public IReadOnlyDictionary<Guid, IReadOnlyList<string>> RecoveryDiagnostics =>
        recoveryDiagnostics.ToDictionary(pair => pair.Key, pair => (IReadOnlyList<string>)pair.Value.ToArray());

    private sealed class SiteState
    {
        public required Guid SiteId { get; init; }
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public Guid Epoch { get; set; }
        public long LatestSequence { get; set; }
        public List<CommandJournalEvent> Journal { get; } = [];
        public Dictionary<Guid, EquipmentCommandStatus> Commands { get; } = [];
        public Dictionary<IdempotencyScope, IdempotencyEntry> Idempotency { get; } = [];
        public Dictionary<Guid, DateTimeOffset> TerminalSince { get; } = [];
        public Queue<Guid> TerminalOrder { get; set; } = new();
    }

    /// <summary>One logical command per (Site, FAB, principal, Idempotency-Key) — the store's primary key.</summary>
    private readonly record struct IdempotencyScope(Guid SiteId, Guid FabId, string Principal, string Key);

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

    /// <summary>Current durable journal epoch of one Site (the <c>epoch</c> half of SSE ids and journal requests).</summary>
    public Guid GetJournalEpoch(Guid siteId)
    {
        if (!sites.TryGetValue(siteId, out var site)) throw new ArgumentException("Unknown Site.", nameof(siteId));
        return site.Epoch;
    }

    /// <summary>Returns the authoritative current state, or null for an unknown/pruned command id.</summary>
    public EquipmentCommandStatus? Get(Guid commandId)
    {
        if (!commandSites.TryGetValue(commandId, out var siteId) || !sites.TryGetValue(siteId, out var site)) return null;
        site.Gate.Wait();
        try
        {
            if (!StoreUnavailable) PruneTerminalCommandsLocked(site);
            if (site.Commands.TryGetValue(commandId, out var status)) return status;
            commandSites.TryRemove(commandId, out _);
            return null;
        }
        finally
        {
            site.Gate.Release();
        }
    }

    /// <summary>
    /// Single atomic submission path. After Site/FAB membership is validated the per-Site lock
    /// decides, in order: (1) idempotency replay for the same key+payload (returns the original
    /// stored accepted snapshot without consulting current capability/state/active capacity),
    /// (2) idempotency conflict for a different payload, (3) capability/state validation for a
    /// brand-new command, (4) one durable store transaction (command + idempotency/outbox + journal
    /// + cursor + per-FAB active-command admission) before 202. Concurrent retries of one key
    /// therefore create exactly one durable command and cannot fail on state that changed after the
    /// original submission, while a brand-new command is admitted only when the target FAB's durable
    /// active-command count is below <see cref="EquipmentCommandOptions.MaxActiveCommandsPerFab"/>
    /// (R4-08; the count is taken in the commit transaction itself, not from a pre-read).
    /// </summary>
    public EquipmentCommandSubmitResult Submit(Guid siteId, EquipmentCommandRequest request, string principal, string idempotencyKey)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(principal);
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);

        if (!directory.TryGetSite(siteId, out _)) return new(EquipmentCommandSubmitStatus.UnknownSite, null);
        if (!Guid.TryParse(request.FabId, out var fabId) || !directory.TryGetFab(siteId, fabId, out var fab))
            return new(EquipmentCommandSubmitStatus.UnknownFab, null);
        if (!sites.TryGetValue(siteId, out var site)) return new(EquipmentCommandSubmitStatus.UnknownSite, null);
        var scope = new IdempotencyScope(siteId, fab.Id, principal, idempotencyKey);
        site.Gate.Wait();
        try
        {
            if (StoreUnavailable) return new(EquipmentCommandSubmitStatus.StoreUnavailable, null);
            PruneTerminalCommandsLocked(site);
            if (StoreUnavailable) return new(EquipmentCommandSubmitStatus.StoreUnavailable, null);
            if (site.Idempotency.TryGetValue(scope, out var existing))
            {
                if (string.Equals(existing.EquipmentId, request.EquipmentId, StringComparison.Ordinal) &&
                    string.Equals(existing.Action, request.Action, StringComparison.Ordinal))
                    return new(EquipmentCommandSubmitStatus.Accepted, existing.Accepted);

                return new(EquipmentCommandSubmitStatus.IdempotencyConflict, null);
            }

            // Brand-new command: current capability and state preconditions must hold.
            if (validator is not null)
            {
                var validation = validator.Validate(siteId, fab, request);
                if (!validation.IsValid) return new(EquipmentCommandSubmitStatus.InvalidCommand, null, validation);
            }

            var commandId = Guid.NewGuid();
            var occurredAt = clock.GetUtcNow().ToString("O");
            var siteText = siteId.ToString("D");
            var fabText = fab.Id.ToString("D");
            var commandText = commandId.ToString("D");
            var accepted = new EquipmentCommandStatus(siteText, fabText, request.EquipmentId, request.Action,
                commandText, 0, AcceptedOutcome, occurredAt);
            var command = new CommandPersistedRecord(siteText, fabText, request.EquipmentId, request.Action,
                commandText, 0, AcceptedOutcome, occurredAt, occurredAt, null);
            var idempotency = new CommandIdempotencyRecord(siteText, fabText, principal, idempotencyKey,
                CommandRequestHash.Compute(siteId, fab.Id, request.EquipmentId, request.Action),
                commandText, JsonSerializer.Serialize(accepted, StoreJson), occurredAt);
            CommandStoreSubmitResult result;
            try
            {
                // Admission is enforced by the store transaction: the durable active-command count
                // and the insert are atomic, so no pre-check window exists. The service's in-memory
                // mirror is only a cache of committed state and is deliberately not consulted here.
                result = store.CommitSubmit(siteId, command, idempotency, options.MaxActiveCommandsPerFab);
            }
            catch (CommandStoreException error)
            {
                RecordFault(error);
                return new(EquipmentCommandSubmitStatus.StoreUnavailable, null);
            }
            switch (result.Status)
            {
                case CommandStoreSubmitStatus.PayloadMismatch:
                    return new(EquipmentCommandSubmitStatus.IdempotencyConflict, null);
                case CommandStoreSubmitStatus.CapacityExceeded:
                    // The transaction rejected the insert atomically: no command, journal event,
                    // idempotency row or in-memory state was created, and the store-reported count
                    // is the authoritative durable active-command count for this FAB.
                    return new(EquipmentCommandSubmitStatus.ActiveCapacityExceeded, null,
                        ActiveCommands: result.ActiveCommands);
                case CommandStoreSubmitStatus.Replayed:
                    var replayed = DeserializeResponse(result.Idempotency ?? throw new CommandStoreException("Replayed submit has no idempotency entry."));
                    site.Idempotency[scope] = new IdempotencyEntry(replayed.EquipmentId, replayed.Action, replayed);
                    return new(EquipmentCommandSubmitStatus.Accepted, replayed);
                default:
                    var journalEvent = result.Event ?? throw new CommandStoreException("Accepted submit has no journal event.");
                    site.LatestSequence = journalEvent.Sequence;
                    site.Commands[commandId] = accepted;
                    commandSites[commandId] = siteId;
                    site.Journal.Add(journalEvent);
                    site.Idempotency[scope] = new IdempotencyEntry(request.EquipmentId, request.Action, accepted);
                    PruneTerminalCommandsLocked(site);
                    _ = SimulateAsync(siteId, commandId, 0);
                    return new(EquipmentCommandSubmitStatus.Accepted, accepted);
            }
        }
        finally
        {
            site.Gate.Release();
        }
    }

    /// <summary>
    /// Resolves one SSE connection's starting point from its Last-Event-ID cursor, optionally
    /// filtered to one FAB. A fresh connection replays the retained window without a gap; a
    /// malformed/foreign epoch, a pruned or missing cursor, or a cursor ahead of the journal
    /// reports <see cref="JournalReadResult.HasGap"/> so the stream can emit replay-gap (+dirty).
    /// </summary>
    public JournalReadResult ReadJournal(Guid siteId, string? lastEventId, string? fabId = null) =>
        ReadJournalCore(siteId, lastEventId, fabId, fresh: true);

    /// <summary>
    /// Live-loop cursor validation: the SSE loop must call this while streaming instead of
    /// silently continuing, so retention holes, a cursor ahead of the journal or an epoch change
    /// surface as <see cref="JournalReadResult.HasGap"/>. Events are already filtered to
    /// <paramref name="fabId"/> when supplied; <paramref name="cursorEpoch"/> is only used by
    /// callers that hold a cursor from a previous Site epoch.
    /// </summary>
    public JournalReadResult ReadJournalSince(Guid siteId, long sequenceExclusive, string? fabId = null, Guid? cursorEpoch = null)
    {
        var site = GetSite(siteId);
        var epoch = cursorEpoch ?? site.Epoch;
        return ReadJournalCore(siteId, $"{epoch:D}:{sequenceExclusive}", fabId, fresh: false);
    }

    /// <summary>Builds the replay-gap control-frame payload for a gapped journal read.</summary>
    public CommandReplayGapDto CreateReplayGap(JournalReadResult result, string? requestedLastEventId, DateTimeOffset? occurredAt = null)
    {
        ArgumentNullException.ThrowIfNull(result);
        return new CommandReplayGapDto(CommandResultTopic, true, result.Epoch.ToString("D"), requestedLastEventId,
            result.FirstRetainedSequence, result.LatestSequence, (occurredAt ?? clock.GetUtcNow()).ToString("O"));
    }

    /// <summary>
    /// Builds the optional <c>event: dirty</c> control frame for a gapped read. Dirty is emitted
    /// only when events may be missing (retention trim or epoch replacement): the client must
    /// reconcile authoritative command state instead of guessing. Malformed or ahead cursors keep
    /// the existing replay-gap-only semantics because no retained event is lost for them.
    /// </summary>
    public CommandDirtyDto? CreateDirty(JournalReadResult result, string? requestedLastEventId)
    {
        ArgumentNullException.ThrowIfNull(result);
        if (!result.HasGap) return null;
        if (!result.CursorAccepted)
        {
            if (!TryParseLastEventId(requestedLastEventId, out var cursorEpoch, out _) || cursorEpoch == result.Epoch) return null;
            return new CommandDirtyDto("epoch-replaced", 0, result.Epoch.ToString("D"), result.LatestSequence,
                clock.GetUtcNow().ToString("O"));
        }
        if (result.DroppedCount <= 0) return null;
        return new CommandDirtyDto("retention-trim", result.DroppedCount, result.Epoch.ToString("D"), result.LatestSequence,
            clock.GetUtcNow().ToString("O"));
    }

    /// <summary>
    /// Authoritative command listing for one FAB (ADR-008 2.2): the browser-refresh and
    /// severe-gap recovery entry point. <paramref name="status"/> is active|terminal|all and
    /// <paramref name="afterRevision"/> keeps commands whose current revision is greater.
    /// </summary>
    public CommandRecoveryListDto ListFabCommands(Guid siteId, Guid fabId, string status, int afterRevision)
    {
        if (status is not (StatusActive or StatusTerminal or StatusAll))
            throw new ArgumentException("status must be active, terminal or all.", nameof(status));
        if (afterRevision < -1) throw new ArgumentOutOfRangeException(nameof(afterRevision));
        var site = GetSite(siteId);
        site.Gate.Wait();
        try
        {
            if (!StoreUnavailable) PruneTerminalCommandsLocked(site);
            var fabText = fabId.ToString("D");
            var commands = site.Commands.Values
                .Where(command => string.Equals(command.FabId, fabText, StringComparison.Ordinal))
                .Where(command => status switch
                {
                    StatusActive => command.Revision < 2,
                    StatusTerminal => command.Revision >= 2,
                    _ => true
                })
                .Where(command => command.Revision > afterRevision)
                .OrderBy(command => DateTimeOffset.Parse(command.OccurredAt, CultureInfo.InvariantCulture))
                .ThenBy(command => command.CommandId, StringComparer.Ordinal)
                .Select(command => new CommandRecoveryDto(command.SiteId, command.FabId, command.CommandId,
                    command.Revision, command.Outcome, command.OccurredAt, command.Revision >= 2))
                .ToArray();
            return new CommandRecoveryListDto(site.Epoch.ToString("D"), site.LatestSequence, commands);
        }
        finally
        {
            site.Gate.Release();
        }
    }

    /// <summary>
    /// Durable journal replay page for one FAB (ADR-008 2.2 / ADR-010 3). The requested epoch is
    /// mandatory and must equal the Site's current epoch; otherwise the caller must answer
    /// 409 journal-epoch-mismatch and reconcile authoritatively. Events are strictly increasing
    /// and greater than <paramref name="afterSequence"/>.
    ///
    /// Gap rule (all comparisons in <see cref="long"/>, computed under the same Site lock):
    /// <c>outsideRetainedWindow = afterSequence &lt; firstRetainedSequence - 1</c>,
    /// <c>beyondLatest = afterSequence &gt; latestSequence</c>,
    /// <c>hasGap = outsideRetainedWindow || beyondLatest || dropped &gt; 0</c>.
    /// A legitimately empty Site (<c>latestSequence = 0</c>, <c>firstRetainedSequence = 1</c>,
    /// <c>afterSequence = 0</c>) is therefore not a gap; a completely pruned retained window
    /// (<c>latestSequence &gt; 0</c>, <c>firstRetainedSequence = latestSequence + 1</c>, old cursor)
    /// is a gap even though the page contains no events. The gap is decided from the retention
    /// bounds before any FAB filtering, so an empty page can never mask it.
    ///
    /// <c>nextAfterSequence</c> is the end of the Site sequence interval the server has scanned:
    /// the last returned event when the FAB-filtered page was truncated, otherwise the
    /// authoritative watermark (<c>latestSequence</c>); an already-ahead cursor is echoed back.
    /// It is monotonic, and while <c>afterSequence &lt; latestSequence</c> it always advances, so
    /// empty FAB-filtered pages cannot stall the recovery loop.
    /// </summary>
    public CommandJournalPageResult ReadCommandJournalPage(Guid siteId, Guid fabId, Guid requestedEpoch, long afterSequence, int limit)
    {
        if (afterSequence < 0) throw new ArgumentOutOfRangeException(nameof(afterSequence));
        if (limit is < 1 or > MaxJournalPageLimit) throw new ArgumentOutOfRangeException(nameof(limit));
        var site = GetSite(siteId);
        site.Gate.Wait();
        try
        {
            if (!StoreUnavailable) PruneTerminalCommandsLocked(site);
            var epoch = site.Epoch;
            var latest = site.LatestSequence;
            var first = EffectiveFirstRetained(site);
            if (requestedEpoch != epoch) return new CommandJournalPageResult(null, new JournalEpochMismatch(epoch, first, latest));

            // R3-01: explicit long-bounded retention checks. A fully empty retained window must be
            // reported as a gap for cursors that predate firstRetainedSequence - 1, including when
            // the FAB-filtered event list is empty.
            var outsideRetainedWindow = afterSequence < first - 1;
            var beyondLatest = afterSequence > latest;
            var dropped = 0L;
            var expected = afterSequence + 1;
            foreach (var journalEvent in site.Journal)
            {
                if (journalEvent.Sequence <= afterSequence) continue;
                if (journalEvent.Sequence > expected) dropped += journalEvent.Sequence - expected;
                expected = journalEvent.Sequence + 1;
            }
            var hasGap = outsideRetainedWindow || beyondLatest || dropped > 0;

            var fabText = fabId.ToString("D");
            var filtered = site.Journal
                .Where(journalEvent => journalEvent.Sequence > afterSequence &&
                                       string.Equals(journalEvent.FabId, fabText, StringComparison.Ordinal))
                .ToArray();
            var events = filtered
                .Take(limit)
                .Select(journalEvent => new CommandJournalEventDto(journalEvent.Sequence, journalEvent.FabId,
                    journalEvent.CommandId, journalEvent.Revision, journalEvent.Outcome, journalEvent.OccurredAt))
                .ToArray();

            // The cursor never regresses; while afterSequence < latest it always advances.
            var nextAfterSequence = events.Length == 0
                ? beyondLatest ? afterSequence : Math.Max(afterSequence, latest)
                : filtered.Length > events.Length ? events[^1].Sequence : Math.Max(events[^1].Sequence, latest);
            return new CommandJournalPageResult(new CommandJournalPageDto(epoch.ToString("D"), hasGap, first, latest,
                nextAfterSequence, events), null);
        }
        finally
        {
            site.Gate.Release();
        }
    }

    /// <summary>
    /// Prunes terminal commands past the configured TTL or beyond the configured terminal count
    /// and applies the journal retention cap. The durable retention transaction (command +
    /// idempotency + journal deletion and cursor advance) commits before the in-memory window
    /// changes, so a failed transaction never reports a prune that was not persisted. Pruning is
    /// also applied lazily on <see cref="Get"/>, <see cref="Submit"/> and the recovery endpoints;
    /// this entry point is deterministic for tests.
    /// </summary>
    public int PruneTerminalCommands()
    {
        var removed = 0;
        foreach (var site in sites.Values)
        {
            site.Gate.Wait();
            try
            {
                if (StoreUnavailable) continue;
                removed += PruneTerminalCommandsLocked(site);
            }
            finally
            {
                site.Gate.Release();
            }
        }
        return removed;
    }

    private SiteState LoadSite(Guid siteId)
    {
        CommandStoreRecovery recovery;
        try
        {
            recovery = store.Recover(siteId);
        }
        catch (CommandStoreException error)
        {
            throw new CommandStoreException($"Durable command recovery failed for Site {siteId:D}; refusing to start with a memory-only store.", error);
        }
        var site = new SiteState { SiteId = siteId, Epoch = recovery.Epoch, LatestSequence = recovery.LatestSequence };
        recoveryDiagnostics[siteId] = recovery.Diagnostics.ToList();
        foreach (var journalEvent in recovery.Events) site.Journal.Add(journalEvent);
        foreach (var record in recovery.Records)
        {
            var status = new EquipmentCommandStatus(record.SiteId, record.FabId, record.EquipmentId, record.Action,
                record.CommandId, record.Revision, record.Outcome, record.OccurredAt);
            var commandId = Guid.Parse(record.CommandId);
            site.Commands[commandId] = status;
            commandSites[commandId] = siteId;
            if (record.Revision >= 2)
            {
                var terminalAt = record.TerminalAt is not null && DateTimeOffset.TryParse(record.TerminalAt, out var parsed)
                    ? parsed : DateTimeOffset.Parse(record.OccurredAt, CultureInfo.InvariantCulture);
                site.TerminalSince[commandId] = terminalAt;
                site.TerminalOrder.Enqueue(commandId);
            }
        }
        foreach (var entry in recovery.Idempotency)
        {
            var accepted = DeserializeResponse(entry);
            var scope = new IdempotencyScope(Guid.Parse(entry.SiteId), Guid.Parse(entry.FabId), entry.Principal, entry.Key);
            site.Idempotency[scope] = new IdempotencyEntry(accepted.EquipmentId, accepted.Action, accepted);
        }
        // Retention is re-applied at startup so a restart is observationally equivalent: expired
        // terminal commands leave the window in one durable retention transaction.
        PruneTerminalCommandsLocked(site);
        foreach (var command in site.Commands.Values.Where(command => command.Revision < 2).ToArray())
            _ = SimulateAsync(siteId, Guid.Parse(command.CommandId), command.Revision);
        return site;
    }

    private static EquipmentCommandStatus DeserializeResponse(CommandIdempotencyRecord entry)
    {
        EquipmentCommandStatus? accepted;
        try
        {
            accepted = JsonSerializer.Deserialize<EquipmentCommandStatus>(entry.ResponseJson, StoreJson);
        }
        catch (JsonException error)
        {
            throw new CommandStoreException($"The committed idempotency response for command {entry.CommandId} is unreadable.", error);
        }
        if (accepted is null || !string.Equals(accepted.CommandId, entry.CommandId, StringComparison.Ordinal))
            throw new CommandStoreException($"The committed idempotency response for command {entry.CommandId} is inconsistent.");
        return accepted;
    }

    private JournalReadResult ReadJournalCore(Guid siteId, string? lastEventId, string? fabId, bool fresh)
    {
        var site = GetSite(siteId);
        site.Gate.Wait();
        try
        {
            var latest = site.LatestSequence;
            var first = EffectiveFirstRetained(site);
            var epoch = site.Epoch;
            if (fresh && string.IsNullOrWhiteSpace(lastEventId))
                return new(Filter(site.Journal, fabId, null).Events, false, false, 0, first, latest, epoch);
            if (!TryParseLastEventId(lastEventId, out var cursorEpoch, out var requested))
                return new(Filter(site.Journal, fabId, null).Events, true, false, 0, first, latest, epoch);
            if (cursorEpoch != epoch)
                return new(Filter(site.Journal, fabId, null).Events, true, false, requested, first, latest, epoch);
            if (requested > latest)
                return new(Filter(site.Journal, fabId, null).Events, true, true, requested, first, latest, epoch);
            if (requested < first - 1)
                return new(Filter(site.Journal, fabId, null).Events, true, true, requested, first, latest, epoch, first - requested - 1);
            var selection = Filter(site.Journal, fabId, requested);
            return new(selection.Events, selection.DroppedCount > 0, true, requested, first, latest, epoch, selection.DroppedCount);
        }
        finally
        {
            site.Gate.Release();
        }
    }

    private static (EquipmentCommandStreamEnvelope[] Events, long DroppedCount) Filter(
        IReadOnlyList<CommandJournalEvent> journal, string? fabId, long? afterSequence)
    {
        var envelopes = new List<EquipmentCommandStreamEnvelope>(journal.Count);
        long dropped = 0;
        var expected = afterSequence is { } cursor ? cursor + 1 : (journal.Count == 0 ? 1 : journal[0].Sequence);
        foreach (var journalEvent in journal)
        {
            if (afterSequence is { } minimum && journalEvent.Sequence <= minimum) continue;
            if (journalEvent.Sequence > expected) dropped += journalEvent.Sequence - expected;
            expected = journalEvent.Sequence + 1;
            if (fabId is not null && !string.Equals(journalEvent.FabId, fabId, StringComparison.Ordinal)) continue;
            envelopes.Add(new EquipmentCommandStreamEnvelope(CommandResultTopic, journalEvent.Sequence,
                new EquipmentCommandStreamPayload(journalEvent.FabId, journalEvent.CommandId, journalEvent.Revision,
                    journalEvent.Outcome, journalEvent.OccurredAt)));
        }
        return (envelopes.ToArray(), dropped);
    }

    private static long EffectiveFirstRetained(SiteState site) =>
        site.LatestSequence == 0 ? 1 : site.Journal.Count == 0 ? site.LatestSequence + 1 : site.Journal[0].Sequence;

    /// <summary>
    /// Applies terminal TTL/capacity pruning and the journal retention cap, committing the durable
    /// retention transaction first and mutating the in-memory window only after it succeeded.
    /// </summary>
    private int PruneTerminalCommandsLocked(SiteState site)
    {
        if (StoreUnavailable) return 0;
        var expiredBefore = clock.GetUtcNow() - options.TerminalTtl;
        var pending = new Queue<Guid>(site.TerminalOrder);
        var pruned = new List<Guid>();
        while (pending.Count > 0)
        {
            var commandId = pending.Peek();
            if (!site.TerminalSince.TryGetValue(commandId, out var terminalAt))
            {
                pending.Dequeue();
                continue;
            }
            if (pending.Count <= options.MaxTerminalCommands && terminalAt > expiredBefore) break;
            pending.Dequeue();
            if (site.Commands.ContainsKey(commandId)) pruned.Add(commandId);
        }
        var prunedSet = pruned.Count == 0 ? [] : new HashSet<Guid>(pruned);
        var retained = site.Journal.Where(journalEvent => !prunedSet.Contains(Guid.Parse(journalEvent.CommandId))).ToList();
        var journalTrimmed = retained.Count > options.MaxJournalEventsPerSite;
        if (journalTrimmed) retained.RemoveRange(0, retained.Count - options.MaxJournalEventsPerSite);
        if (pruned.Count == 0 && !journalTrimmed)
        {
            site.TerminalOrder = pending;
            return 0;
        }
        var first = retained.Count == 0 ? site.LatestSequence + 1 : retained[0].Sequence;
        try
        {
            store.CommitRetention(site.SiteId, new CommandRetentionUpdate(first,
                pruned.Select(commandId => commandId.ToString("D")).ToArray()));
        }
        catch (CommandStoreException error)
        {
            RecordFault(error);
            return 0;
        }
        site.Journal.Clear();
        site.Journal.AddRange(retained);
        site.TerminalOrder = pending;
        foreach (var commandId in pruned)
        {
            site.TerminalSince.Remove(commandId);
            site.Commands.Remove(commandId);
            commandSites.TryRemove(commandId, out _);
        }
        if (pruned.Count > 0)
        {
            var removedCommandIds = new HashSet<string>(pruned.Select(commandId => commandId.ToString("D")), StringComparer.Ordinal);
            foreach (var scope in site.Idempotency
                         .Where(pair => removedCommandIds.Contains(pair.Value.Accepted.CommandId))
                         .Select(pair => pair.Key).ToArray())
                site.Idempotency.Remove(scope);
        }
        return pruned.Count;
    }

    private SiteState GetSite(Guid siteId) =>
        sites.TryGetValue(siteId, out var site) ? site : throw new ArgumentException("Unknown Site.", nameof(siteId));

    private void RecordFault(CommandStoreException error) =>
        Interlocked.CompareExchange(ref storeFault, error, null);

    private async Task SimulateAsync(Guid siteId, Guid commandId, int startRevision)
    {
        try
        {
            if (startRevision < 1)
            {
                await Task.Delay(options.ExecutingDelay).ConfigureAwait(false);
                Advance(siteId, commandId, 1, ExecutingOutcome);
            }
            await Task.Delay(options.SucceededDelay - options.ExecutingDelay).ConfigureAwait(false);
            Advance(siteId, commandId, 2, SucceededOutcome);
        }
        catch
        {
            // Development-only simulation: background transitions must never surface as request
            // failures. A durable write failure is recorded as a store fault by Advance and is
            // reported by the dirty/resync paths instead of being silently dropped.
        }
    }

    private void Advance(Guid siteId, Guid commandId, int revision, string outcome)
    {
        if (!sites.TryGetValue(siteId, out var site)) return;
        site.Gate.Wait();
        try
        {
            if (StoreUnavailable) return;
            if (!site.Commands.TryGetValue(commandId, out var current)) return;
            if (current.Revision >= revision) return;
            var occurredAt = clock.GetUtcNow().ToString("O");
            CommandJournalEvent? journalEvent;
            try
            {
                journalEvent = store.CommitAdvance(siteId, commandId.ToString("D"), current.Revision, revision,
                    outcome, occurredAt, revision >= 2 ? occurredAt : null);
            }
            catch (CommandStoreException error)
            {
                RecordFault(error);
                return;
            }
            if (journalEvent is null) return;
            site.LatestSequence = journalEvent.Sequence;
            site.Commands[commandId] = current with { Revision = revision, Outcome = outcome, OccurredAt = occurredAt };
            site.Journal.Add(journalEvent);
            if (revision >= 2)
            {
                site.TerminalSince[commandId] = clock.GetUtcNow();
                site.TerminalOrder.Enqueue(commandId);
            }
            PruneTerminalCommandsLocked(site);
        }
        finally
        {
            site.Gate.Release();
        }
    }
}
