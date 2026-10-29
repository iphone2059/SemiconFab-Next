using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace Fab.App;

/// <summary>
/// Development-only local-disk durable command store (ADR-008 2.1/2.3). Layout under
/// <c>&lt;dataDirectory&gt;/&lt;siteId:D&gt;/</c>:
/// <list type="bullet">
/// <item><c>epoch.json</c> — current journal epoch plus retention cursors (atomic tmp + fsync + rename).</item>
/// <item><c>journal/&lt;epoch&gt;.jsonl</c> — append-only journal, one event per line, fsynced before the caller is told the write succeeded.</item>
/// <item><c>commands/&lt;commandId&gt;.json</c> — authoritative command record with its bounded event history (atomic).</item>
/// <item><c>idempotency/&lt;hash prefix&gt;/&lt;sha256(scope)&gt;.json</c> — restart-surviving idempotency mapping (atomic).</item>
/// </list>
/// Writes are serialized per Site by a <see cref="SemaphoreSlim"/> so sequences stay monotonic and
/// journal appends keep their order. Every failure is surfaced as <see cref="CommandStoreException"/>;
/// the store never falls back to memory.
///
/// Terminal pruning removes the pruned command's journal events, so the retained journal is a
/// subsequence of the assigned sequence numbers: a missing sequence inside the retained window is
/// a real gap and is reported (never silently skipped).
/// </summary>
public sealed class FileCommandStore : ICommandStore
{
    /// <summary>Physical journal lines may run this far ahead of the retained window before an atomic rewrite.</summary>
    private const int JournalRewriteSlack = 512;

    private readonly string rootDirectory;
    private readonly ConcurrentDictionary<Guid, SiteStore> sites = new();

    public FileCommandStore(string directory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        rootDirectory = Path.GetFullPath(directory);
        if (rootDirectory.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Development command storage requires a local disk directory.", nameof(directory));
        try
        {
            Directory.CreateDirectory(rootDirectory);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new CommandStoreException("Cannot create the durable command store directory.", error);
        }
    }

    public CommandStoreRecovery Recover(Guid siteId) => Guard(() =>
    {
        var site = sites.GetOrAdd(siteId, CreateSite);
        site.Gate.Wait();
        try
        {
            if (site.Recovery is not null) return site.Recovery;
            var recovery = RecoverSite(site, siteId);
            site.Recovery = recovery;
            site.Loaded = true;
            return recovery;
        }
        finally
        {
            site.Gate.Release();
        }
    });

    public CommandJournalEvent CommitAccepted(Guid siteId, CommandPersistedRecord record, CommandIdempotencyRecord idempotency) => Guard(() =>
    {
        var site = RequireSite(siteId);
        site.Gate.Wait();
        try
        {
            var journalEvent = NextEvent(site, record);
            WriteRecord(site, record with { Events = [.. record.Events, journalEvent] });
            WriteIdempotency(site, idempotency);
            AppendJournal(site, journalEvent);
            return journalEvent;
        }
        finally
        {
            site.Gate.Release();
        }
    });

    public CommandJournalEvent CommitAdvance(Guid siteId, CommandPersistedRecord record) => Guard(() =>
    {
        var site = RequireSite(siteId);
        site.Gate.Wait();
        try
        {
            var journalEvent = NextEvent(site, record);
            WriteRecord(site, record with { Events = [.. record.Events, journalEvent] });
            AppendJournal(site, journalEvent);
            return journalEvent;
        }
        finally
        {
            site.Gate.Release();
        }
    });

    public void CommitRetention(Guid siteId, CommandRetentionUpdate update) => Guard(() =>
    {
        ArgumentNullException.ThrowIfNull(update);
        var site = RequireSite(siteId);
        site.Gate.Wait();
        try
        {
            if (update.FirstRetainedSequence < 0 || update.FirstRetainedSequence > site.Latest + 1)
                throw new CommandStoreException("Retention cursor is outside the durable journal window.");
            var retained = update.RetainedEvents;
            var previous = 0L;
            foreach (var journalEvent in retained)
            {
                if (journalEvent.Sequence <= previous || journalEvent.Sequence > site.Latest)
                    throw new CommandStoreException("Retained journal events must be strictly increasing and inside the assigned window.");
                previous = journalEvent.Sequence;
            }
            var rewrite = update.PrunedCommandIds.Length > 0 || retained.Length == 0 ||
                          site.PhysicalJournalCount - retained.Length > JournalRewriteSlack;
            site.FirstRetained = update.FirstRetainedSequence;
            if (rewrite)
            {
                RewriteJournal(site, retained);
            }
            else
            {
                WriteEpoch(site);
            }
            foreach (var commandId in update.PrunedCommandIds) DeleteRecord(site, commandId);
            foreach (var scope in update.PrunedIdempotencyScopes) DeleteIdempotencyFile(site, scope);
        }
        finally
        {
            site.Gate.Release();
        }
    });

    public void DeleteIdempotency(Guid siteId, IReadOnlyCollection<string> scopes) => Guard(() =>
    {
        ArgumentNullException.ThrowIfNull(scopes);
        var site = RequireSite(siteId);
        site.Gate.Wait();
        try
        {
            foreach (var scope in scopes) DeleteIdempotencyFile(site, scope);
        }
        finally
        {
            site.Gate.Release();
        }
    });

    /// <summary>Recovery of one Site: journal/record cross-checks, outbox repair and epoch replacement.</summary>
    private CommandStoreRecovery RecoverSite(SiteStore site, Guid siteId)
    {
        var diagnostics = new List<string>();
        var hadDurableFiles = Directory.EnumerateFiles(site.JournalDirectory, "*.jsonl").Any() ||
                              Directory.EnumerateFiles(site.CommandsDirectory, "*.json").Any() ||
                              File.Exists(site.EpochPath);
        var records = ReadRecords(site, siteId, diagnostics);
        var idempotency = ReadIdempotency(site, siteId, diagnostics);
        var existing = TryLoadExistingEpoch(site, siteId, diagnostics);
        if (existing is null)
        {
            var replaced = StartNewEpoch(site, siteId, records, diagnostics, hadDurableFiles);
            return new CommandStoreRecovery(replaced.Epoch, replaced.First, replaced.Latest, replaced.Events,
                replaced.Records, ValidateIdempotency(site, idempotency, replaced.Records, diagnostics), diagnostics.ToArray());
        }
        var events = existing.Value.Events.ToList();
        var first = existing.Value.First;
        var latest = existing.Value.Latest;
        var journalChanged = false;
        var outbox = RepairJournalFromRecords(site, records, events, latest, diagnostics);
        records = outbox.Records;
        latest = outbox.Latest;
        journalChanged |= outbox.Changed;
        var recordById = records.ToDictionary(record => record.CommandId, StringComparer.Ordinal);
        foreach (var group in events.GroupBy(journalEvent => journalEvent.CommandId, StringComparer.Ordinal))
        {
            if (recordById.ContainsKey(group.Key)) continue;
            var ordered = group.OrderBy(journalEvent => journalEvent.Sequence).ToArray();
            var last = ordered[^1];
            var rebuilt = new CommandPersistedRecord(siteId.ToString("D"), last.FabId, last.EquipmentId, last.Action,
                last.CommandId, last.Revision, last.Outcome, ordered[0].OccurredAt, last.OccurredAt,
                IsTerminal(last.Revision) ? last.OccurredAt : null, ordered);
            WriteRecord(site, rebuilt);
            records.Add(rebuilt);
            recordById[rebuilt.CommandId] = rebuilt;
            diagnostics.Add("record-rebuilt-from-journal");
        }
        for (var index = 0; index < records.Count; index++)
        {
            var record = records[index];
            var newest = events.Where(journalEvent => journalEvent.CommandId == record.CommandId)
                .OrderBy(journalEvent => journalEvent.Sequence).LastOrDefault();
            var newestRecorded = record.Events.Length == 0 ? 0 : record.Events[^1].Sequence;
            if (newest is null || newest.Sequence <= newestRecorded) continue;
            var merged = record.Events.Concat(events.Where(journalEvent => journalEvent.CommandId == record.CommandId))
                .GroupBy(journalEvent => journalEvent.Sequence).Select(group => group.Last())
                .OrderBy(journalEvent => journalEvent.Sequence).ToArray();
            var repaired = record with
            {
                Revision = newest.Revision,
                Outcome = newest.Outcome,
                OccurredAt = newest.OccurredAt,
                TerminalAt = IsTerminal(newest.Revision) ? newest.OccurredAt : record.TerminalAt,
                Events = merged
            };
            WriteRecord(site, repaired);
            records[index] = repaired;
            diagnostics.Add("record-repaired-from-journal");
        }
        site.Epoch = existing.Value.Epoch;
        site.EpochCreatedAt = existing.Value.CreatedAt;
        site.FirstRetained = first;
        site.Latest = latest;
        if (journalChanged)
        {
            RewriteJournal(site, events);
        }
        else
        {
            site.PhysicalJournalCount = existing.Value.PhysicalCount;
            site.JournalLast = events.Count == 0 ? 0 : events[^1].Sequence;
            WriteEpoch(site);
        }
        var idempotent = ValidateIdempotency(site, idempotency, records, diagnostics);
        return new CommandStoreRecovery(site.Epoch, first, latest, events.ToArray(), records.ToArray(), idempotent, diagnostics.ToArray());
    }

    private (List<CommandPersistedRecord> Records, long Latest, bool Changed) RepairJournalFromRecords(
        SiteStore site, List<CommandPersistedRecord> records, List<CommandJournalEvent> events, long latest, List<string> diagnostics)
    {
        var missing = new List<CommandJournalEvent>();
        foreach (var record in records)
        {
            foreach (var journalEvent in record.Events)
            {
                if (journalEvent.Sequence > latest) missing.Add(journalEvent);
            }
        }
        if (missing.Count == 0) return (records, latest, false);
        missing.Sort((left, right) => left.Sequence.CompareTo(right.Sequence));
        var renumbered = new Dictionary<long, long>();
        var next = latest;
        foreach (var journalEvent in missing)
        {
            next++;
            renumbered[journalEvent.Sequence] = next;
            events.Add(journalEvent with { Sequence = next });
        }
        var updated = new List<CommandPersistedRecord>(records.Count);
        foreach (var record in records)
        {
            var eventsChanged = record.Events.Any(journalEvent => renumbered.ContainsKey(journalEvent.Sequence));
            var repaired = eventsChanged
                ? record with { Events = record.Events.Select(journalEvent => renumbered.TryGetValue(journalEvent.Sequence, out var nextSequence) ? journalEvent with { Sequence = nextSequence } : journalEvent).ToArray() }
                : record;
            if (eventsChanged) WriteRecord(site, repaired);
            updated.Add(repaired);
        }
        diagnostics.Add("journal-repaired-from-records");
        return (updated, next, true);
    }

    private (Guid Epoch, long First, long Latest, CommandJournalEvent[] Events, CommandPersistedRecord[] Records) StartNewEpoch(
        SiteStore site, Guid siteId, List<CommandPersistedRecord> records, List<string> diagnostics, bool hadDurableFiles)
    {
        var epoch = Guid.NewGuid();
        var events = new List<CommandJournalEvent>();
        var normalized = new List<CommandPersistedRecord>();
        foreach (var record in records.OrderBy(candidate => candidate.CreatedAt, StringComparer.Ordinal)
                     .ThenBy(candidate => candidate.CommandId, StringComparer.Ordinal))
        {
            var normalizedRecord = NormalizeRecord(record);
            var rebuilt = new List<CommandJournalEvent>();
            foreach (var journalEvent in normalizedRecord.Events.OrderBy(candidate => candidate.Revision))
            {
                var assigned = journalEvent with { Sequence = events.Count + 1, SiteId = siteId.ToString("D") };
                events.Add(assigned);
                rebuilt.Add(assigned);
            }
            normalized.Add(normalizedRecord with { Events = rebuilt.ToArray() });
        }
        var first = events.Count == 0 ? 0 : events[0].Sequence;
        var latest = events.Count == 0 ? 0 : events[^1].Sequence;
        site.Epoch = epoch;
        site.EpochCreatedAt = DateTimeOffset.UtcNow;
        site.FirstRetained = first;
        site.Latest = latest;
        site.PhysicalJournalCount = events.Count;
        RewriteJournal(site, events.ToArray());
        foreach (var record in normalized) WriteRecord(site, record);
        if (hadDurableFiles) diagnostics.Add("journal-replaced-with-new-epoch");
        return (epoch, first, latest, events.ToArray(), normalized.ToArray());
    }

    private (Guid Epoch, DateTimeOffset CreatedAt, long First, long Latest, CommandJournalEvent[] Events, int PhysicalCount)? TryLoadExistingEpoch(
        SiteStore site, Guid siteId, List<string> diagnostics)
    {
        if (!File.Exists(site.EpochPath))
        {
            diagnostics.Add("epoch-file-missing");
            return null;
        }
        EpochFile? epochFile;
        try
        {
            epochFile = JsonSerializer.Deserialize<EpochFile>(File.ReadAllBytes(site.EpochPath), CommandStoreJson.Options);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
        {
            diagnostics.Add("epoch-file-unreadable");
            return null;
        }
        if (epochFile is null || epochFile.Epoch == Guid.Empty || epochFile.LatestSequence < 0 ||
            epochFile.FirstRetainedSequence < 0 || epochFile.FirstRetainedSequence > epochFile.LatestSequence + 1 ||
            epochFile.JournalLastSequence < 0 || epochFile.JournalLastSequence > epochFile.LatestSequence)
        {
            diagnostics.Add("epoch-file-invalid");
            return null;
        }
        var journalPath = JournalPath(site, epochFile.Epoch);
        if (!File.Exists(journalPath))
        {
            diagnostics.Add("journal-file-missing");
            return null;
        }
        var lines = TryReadJournalLines(journalPath, siteId, out var journalError);
        if (lines is null)
        {
            diagnostics.Add(journalError);
            return null;
        }
        var physical = lines.Length;
        long first;
        long latest;
        CommandJournalEvent[] retained;
        if (lines.Length == 0)
        {
            if (epochFile.JournalLastSequence != 0)
            {
                diagnostics.Add("journal-empty-with-retained-cursor");
                return null;
            }
            first = epochFile.FirstRetainedSequence;
            latest = epochFile.LatestSequence;
            retained = [];
        }
        else
        {
            var journalLast = lines[^1].Sequence;
            if (journalLast < epochFile.JournalLastSequence)
            {
                diagnostics.Add("journal-tail-lost");
                return null;
            }
            if (journalLast > epochFile.JournalLastSequence) diagnostics.Add("journal-last-repaired");
            latest = Math.Max(epochFile.LatestSequence, journalLast);
            first = epochFile.FirstRetainedSequence;
            if (first > latest + 1)
            {
                diagnostics.Add("retention-cursor-ahead-of-journal");
                return null;
            }
            if (first < lines[0].Sequence)
            {
                diagnostics.Add("retention-cursor-repaired");
                first = lines[0].Sequence;
            }
            retained = lines.Where(journalEvent => journalEvent.Sequence >= first).ToArray();
        }
        site.JournalLast = retained.Length == 0 ? 0 : retained[^1].Sequence;
        return (epochFile.Epoch, epochFile.CreatedAt, first, latest, retained, physical);
    }

    private List<CommandPersistedRecord> ReadRecords(SiteStore site, Guid siteId, List<string> diagnostics)
    {
        var records = new List<CommandPersistedRecord>();
        foreach (var path in Directory.EnumerateFiles(site.CommandsDirectory, "*.json"))
        {
            try
            {
                var record = JsonSerializer.Deserialize<CommandPersistedRecord>(File.ReadAllBytes(path), CommandStoreJson.Options);
                if (record is null)
                {
                    diagnostics.Add("record-invalid:" + Path.GetFileName(path));
                    continue;
                }
                if (CommandRecordValidation.Error(record, siteId) is { } error)
                {
                    diagnostics.Add("record-invalid:" + Path.GetFileName(path) + ":" + error);
                    continue;
                }
                if (!string.Equals(Path.GetFileNameWithoutExtension(path), Guid.Parse(record.CommandId).ToString("D"), StringComparison.Ordinal))
                {
                    diagnostics.Add("record-misnamed:" + Path.GetFileName(path));
                    continue;
                }
                records.Add(record);
            }
            catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException or FormatException)
            {
                diagnostics.Add("record-unreadable:" + Path.GetFileName(path));
            }
        }
        return records;
    }

    private List<CommandIdempotencyRecord> ReadIdempotency(SiteStore site, Guid siteId, List<string> diagnostics)
    {
        var entries = new List<CommandIdempotencyRecord>();
        foreach (var path in Directory.EnumerateFiles(site.IdempotencyDirectory, "*.json", SearchOption.AllDirectories))
        {
            try
            {
                var entry = JsonSerializer.Deserialize<CommandIdempotencyRecord>(File.ReadAllBytes(path), CommandStoreJson.Options);
                if (entry is null || !IsValidScope(entry.Scope) ||
                    !string.Equals(Path.GetFileNameWithoutExtension(path), entry.Scope, StringComparison.Ordinal) ||
                    !string.Equals(entry.SiteId, siteId.ToString("D"), StringComparison.Ordinal) ||
                    !Guid.TryParse(entry.FabId, out _) || !Guid.TryParse(entry.CommandId, out _) ||
                    !string.Equals(Path.GetFullPath(path), Path.GetFullPath(IdempotencyPath(site, entry.Scope)), StringComparison.OrdinalIgnoreCase))
                {
                    diagnostics.Add("idempotency-invalid:" + Path.GetFileName(path));
                    TryDelete(path);
                    continue;
                }
                entries.Add(entry);
            }
            catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
            {
                diagnostics.Add("idempotency-unreadable:" + Path.GetFileName(path));
                TryDelete(path);
            }
        }
        return entries;
    }

    private CommandIdempotencyRecord[] ValidateIdempotency(SiteStore site, List<CommandIdempotencyRecord> entries,
        IReadOnlyCollection<CommandPersistedRecord> records, List<string> diagnostics)
    {
        var commandIds = new HashSet<string>(records.Select(record => record.CommandId), StringComparer.Ordinal);
        var valid = new List<CommandIdempotencyRecord>(entries.Count);
        foreach (var entry in entries.OrderBy(candidate => candidate.CreatedAt, StringComparer.Ordinal).ThenBy(candidate => candidate.Scope, StringComparer.Ordinal))
        {
            if (!commandIds.Contains(entry.CommandId))
            {
                diagnostics.Add("idempotency-dangling:" + entry.Scope[..Math.Min(8, entry.Scope.Length)]);
                DeleteIdempotencyFile(site, entry.Scope);
                continue;
            }
            valid.Add(entry);
        }
        return valid.ToArray();
    }

    private static CommandPersistedRecord NormalizeRecord(CommandPersistedRecord record)
    {
        if (record.Events.Length == record.Revision + 1)
        {
            var ordered = record.Events.OrderBy(journalEvent => journalEvent.Revision).ToArray();
            var complete = true;
            for (var revision = 0; revision < ordered.Length; revision++)
            {
                if (ordered[revision].Revision != revision) complete = false;
            }
            if (complete) return record with { Events = ordered };
        }
        var rebuilt = new List<CommandJournalEvent>(record.Revision + 1);
        for (var revision = 0; revision <= record.Revision; revision++)
        {
            var outcome = revision == 0 ? "accepted" : revision == record.Revision ? record.Outcome : "executing";
            var occurredAt = revision == record.Revision ? record.OccurredAt : record.CreatedAt;
            rebuilt.Add(new CommandJournalEvent(0, record.SiteId, record.FabId, record.CommandId, record.EquipmentId,
                record.Action, revision, outcome, occurredAt));
        }
        return record with { Events = rebuilt.ToArray() };
    }

    private static bool IsTerminal(int revision) => revision >= 2;

    private static CommandJournalEvent NextEvent(SiteStore site, CommandPersistedRecord record) =>
        new(site.Latest + 1, record.SiteId, record.FabId, record.CommandId, record.EquipmentId,
            record.Action, record.Revision, record.Outcome, record.OccurredAt);

    private void AppendJournal(SiteStore site, CommandJournalEvent journalEvent)
    {
        var line = JsonSerializer.Serialize(journalEvent, CommandStoreJson.Options) + "\n";
        try
        {
            using var stream = new FileStream(JournalPath(site, site.Epoch), FileMode.Append, FileAccess.Write, FileShare.Read);
            stream.Write(Encoding.UTF8.GetBytes(line));
            stream.Flush(flushToDisk: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new CommandStoreException("Durable command journal append failed.", error);
        }
        site.Latest = journalEvent.Sequence;
        site.JournalLast = journalEvent.Sequence;
        if (site.FirstRetained == 0) site.FirstRetained = journalEvent.Sequence;
        site.PhysicalJournalCount++;
        WriteEpoch(site);
    }

    private void RewriteJournal(SiteStore site, IReadOnlyList<CommandJournalEvent> events)
    {
        var builder = new StringBuilder();
        foreach (var journalEvent in events) builder.Append(JsonSerializer.Serialize(journalEvent, CommandStoreJson.Options)).Append('\n');
        AtomicWrite(JournalPath(site, site.Epoch), Encoding.UTF8.GetBytes(builder.ToString()));
        site.PhysicalJournalCount = events.Count;
        site.JournalLast = events.Count == 0 ? 0 : events[^1].Sequence;
        WriteEpoch(site);
    }

    private void WriteEpoch(SiteStore site)
    {
        var epoch = new EpochFile
        {
            Epoch = site.Epoch,
            CreatedAt = site.EpochCreatedAt,
            FirstRetainedSequence = site.FirstRetained,
            LatestSequence = site.Latest,
            JournalLastSequence = site.JournalLast
        };
        AtomicWrite(site.EpochPath, JsonSerializer.SerializeToUtf8Bytes(epoch, CommandStoreJson.Options));
    }

    private void WriteRecord(SiteStore site, CommandPersistedRecord record)
    {
        var path = Path.Combine(site.CommandsDirectory, Guid.Parse(record.CommandId).ToString("D") + ".json");
        AtomicWrite(path, JsonSerializer.SerializeToUtf8Bytes(record, CommandStoreJson.Options));
    }

    private static void DeleteRecord(SiteStore site, string commandId)
    {
        var path = Path.Combine(site.CommandsDirectory, Guid.Parse(commandId).ToString("D") + ".json");
        TryDelete(path);
    }

    private void WriteIdempotency(SiteStore site, CommandIdempotencyRecord entry)
    {
        if (!IsValidScope(entry.Scope)) throw new CommandStoreException("Idempotency scope hash is invalid.");
        var path = IdempotencyPath(site, entry.Scope);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        AtomicWrite(path, JsonSerializer.SerializeToUtf8Bytes(entry, CommandStoreJson.Options));
    }

    private static void DeleteIdempotencyFile(SiteStore site, string scope)
    {
        if (!IsValidScope(scope)) return;
        TryDelete(IdempotencyPath(site, scope));
    }

    private static bool IsValidScope(string scope)
    {
        if (scope.Length != 64) return false;
        foreach (var character in scope)
        {
            if (!char.IsAsciiHexDigitLower(character)) return false;
        }
        return true;
    }

    private static string IdempotencyPath(SiteStore site, string scope) =>
        Path.Combine(site.IdempotencyDirectory, scope[..2], scope + ".json");

    private static string JournalPath(SiteStore site, Guid epoch) =>
        Path.Combine(site.JournalDirectory, epoch.ToString("D") + ".jsonl");

    private static CommandJournalEvent[]? TryReadJournalLines(string path, Guid siteId, out string error)
    {
        error = "";
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch (Exception failure) when (failure is IOException or UnauthorizedAccessException)
        {
            error = "journal-unreadable";
            return null;
        }
        if (bytes.Length == 0) return [];
        var text = Encoding.UTF8.GetString(bytes);
        if (!text.EndsWith('\n'))
        {
            error = "journal-truncated";
            return null;
        }
        var lines = text.Split('\n');
        var events = new List<CommandJournalEvent>(lines.Length - 1);
        for (var index = 0; index < lines.Length - 1; index++)
        {
            var line = lines[index];
            if (line.Length == 0)
            {
                error = "journal-blank-line";
                return null;
            }
            CommandJournalEvent? journalEvent;
            try
            {
                journalEvent = JsonSerializer.Deserialize<CommandJournalEvent>(line, CommandStoreJson.Options);
            }
            catch (JsonException)
            {
                error = "journal-corrupt-line";
                return null;
            }
            if (journalEvent is null || !IsValidJournalEvent(journalEvent, siteId))
            {
                error = "journal-invalid-line";
                return null;
            }
            if (journalEvent.Sequence < 1)
            {
                error = "journal-sequence-invalid";
                return null;
            }
            if (events.Count > 0 && journalEvent.Sequence <= events[^1].Sequence)
            {
                error = "journal-sequence-not-increasing";
                return null;
            }
            events.Add(journalEvent);
        }
        return events.ToArray();
    }

    private static bool IsValidJournalEvent(CommandJournalEvent journalEvent, Guid siteId) =>
        string.Equals(journalEvent.SiteId, siteId.ToString("D"), StringComparison.Ordinal) &&
        Guid.TryParse(journalEvent.FabId, out _) &&
        Guid.TryParse(journalEvent.CommandId, out _) &&
        !string.IsNullOrWhiteSpace(journalEvent.EquipmentId) &&
        !string.IsNullOrWhiteSpace(journalEvent.Action) &&
        journalEvent.Revision is >= 0 and <= 2 &&
        !string.IsNullOrWhiteSpace(journalEvent.Outcome) &&
        DateTimeOffset.TryParse(journalEvent.OccurredAt, out _);

    private SiteStore RequireSite(Guid siteId)
    {
        if (!sites.TryGetValue(siteId, out var site) || !site.Loaded)
            throw new CommandStoreException($"The command store for Site {siteId:D} was not recovered before use.");
        return site;
    }

    private SiteStore CreateSite(Guid siteId)
    {
        try
        {
            var directory = Path.Combine(rootDirectory, siteId.ToString("D"));
            var journalDirectory = Path.Combine(directory, "journal");
            var commandsDirectory = Path.Combine(directory, "commands");
            var idempotencyDirectory = Path.Combine(directory, "idempotency");
            Directory.CreateDirectory(journalDirectory);
            Directory.CreateDirectory(commandsDirectory);
            Directory.CreateDirectory(idempotencyDirectory);
            return new SiteStore
            {
                JournalDirectory = journalDirectory,
                CommandsDirectory = commandsDirectory,
                IdempotencyDirectory = idempotencyDirectory,
                EpochPath = Path.Combine(directory, "epoch.json"),
                EpochCreatedAt = DateTimeOffset.UtcNow
            };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new CommandStoreException($"Cannot create the durable command store for Site {siteId:D}.", error);
        }
    }

    private static void AtomicWrite(string path, byte[] bytes)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new CommandStoreException("Durable command store write failed.", error);
        }
        finally
        {
            try
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                // A leftover temporary file is inert: recovery only reads *.json / *.jsonl.
            }
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new CommandStoreException("Durable command store delete failed.", error);
        }
    }

    private static void Guard(Action action) => Guard(() =>
    {
        action();
        return true;
    });

    private static T Guard<T>(Func<T> action)
    {
        try
        {
            return action();
        }
        catch (CommandStoreException)
        {
            throw;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            throw new CommandStoreException("Durable command store operation failed.", error);
        }
    }

    private sealed class SiteStore
    {
        public required string JournalDirectory { get; init; }
        public required string CommandsDirectory { get; init; }
        public required string IdempotencyDirectory { get; init; }
        public required string EpochPath { get; init; }
        public DateTimeOffset EpochCreatedAt { get; set; }
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public Guid Epoch { get; set; }
        public long FirstRetained { get; set; }
        public long Latest { get; set; }
        public long JournalLast { get; set; }
        public int PhysicalJournalCount { get; set; }
        public bool Loaded { get; set; }
        public CommandStoreRecovery? Recovery { get; set; }
    }

    private sealed class EpochFile
    {
        public Guid Epoch { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
        public long FirstRetainedSequence { get; set; }
        public long LatestSequence { get; set; }
        public long JournalLastSequence { get; set; }
    }
}