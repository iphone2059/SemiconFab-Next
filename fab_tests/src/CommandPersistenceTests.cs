using System.Diagnostics;
using System.Text.Json.Nodes;
using Fab.App;
using Fab.Site;
using Xunit;

namespace Fab.Tests;

/// <summary>
/// ADR-008 durable command recovery coverage: restart over the same data directory, idempotency
/// replay, exact journal cursor replay, retention gaps, journal truncation/deletion (new epoch),
/// the record→journal outbox repair window, concurrent sequence monotonicity and explicit IO
/// failure. Every test uses an OS temporary directory, never the repository .local/data.
/// </summary>
public sealed class CommandPersistenceTests : IDisposable
{
    private static readonly Guid SiteId = SiteDirectory.DemoSiteId;
    private static readonly string FabId = SiteDirectory.CreateFab(1).Id.ToString("D");
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(10);
    private readonly List<string> roots = [];

    public void Dispose()
    {
        foreach (var root in roots) TestDataDirectory.Delete(root);
        roots.Clear();
    }

    [Fact]
    public async Task RestartPreservesIdempotentReplayAndRevisionOutcome()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var accepted = Submit(first, "equipment-0", "restart-replay-1");
        var before = await WaitTerminalAsync(first, accepted.CommandId);
        var epochBefore = first.GetJournalEpoch(SiteId);
        var latestBefore = first.ReadJournal(SiteId, null).LatestSequence;
        Assert.Equal(2, before.Revision);
        Assert.Equal(EquipmentCommandService.SucceededOutcome, before.Outcome);

        var restarted = Service(root, options);
        var after = restarted.Get(Guid.Parse(accepted.CommandId));
        Assert.NotNull(after);
        Assert.Equal(before, after);
        Assert.Equal(epochBefore, restarted.GetJournalEpoch(SiteId));
        Assert.True(restarted.ReadJournal(SiteId, null).LatestSequence >= latestBefore);

        var replay = Submit(restarted, "equipment-0", "restart-replay-1");
        Assert.Equal(accepted.CommandId, replay.CommandId);
        Assert.Equal(0, replay.Revision);
        Assert.Equal(EquipmentCommandService.AcceptedOutcome, replay.Outcome);
        Assert.Equal(accepted.OccurredAt, replay.OccurredAt);
        Assert.Single(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
    }

    [Fact]
    public async Task RestartReplaysJournalExactlyFromOldCursorWithoutGap()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "restart-cursor-1");
        await WaitTerminalAsync(first, command.CommandId);
        var snapshot = first.ReadJournal(SiteId, null, FabId);
        Assert.Equal(new long[] { 1, 2, 3 }, snapshot.Events.Select(envelope => envelope.Sequence).ToArray());
        var epoch = first.GetJournalEpoch(SiteId);
        var cursor = 1L;
        var expected = snapshot.Events.Where(envelope => envelope.Sequence > cursor)
            .Select(envelope => (envelope.Sequence, envelope.Payload.Revision, envelope.Payload.Outcome)).ToArray();

        var restarted = Service(root, options);
        var resumed = restarted.ReadJournal(SiteId, $"{epoch:D}:{cursor}", FabId);
        Assert.False(resumed.HasGap);
        Assert.True(resumed.CursorAccepted);
        Assert.Equal(epoch, resumed.Epoch);
        Assert.Equal(expected, resumed.Events.Select(envelope => (envelope.Sequence, envelope.Payload.Revision, envelope.Payload.Outcome)).ToArray());
        Assert.Null(restarted.CreateDirty(resumed, $"{epoch:D}:{cursor}"));
    }

    [Fact]
    public async Task PrunedCursorReportsGapAfterRestart()
    {
        var root = Root();
        var options = FastOptions(new EquipmentCommandOptions { MaxTerminalCommands = 1 });
        var first = Service(root, options);
        var pruned = Submit(first, "equipment-0", "prune-1");
        await WaitTerminalAsync(first, pruned.CommandId);
        var kept = Submit(first, "equipment-1", "prune-2");
        await WaitTerminalAsync(first, kept.CommandId);
        Assert.Null(first.Get(Guid.Parse(pruned.CommandId)));
        var epoch = first.GetJournalEpoch(SiteId);

        var restarted = Service(root, options);
        Assert.Null(restarted.Get(Guid.Parse(pruned.CommandId)));
        Assert.NotNull(restarted.Get(Guid.Parse(kept.CommandId)));
        var result = restarted.ReadJournal(SiteId, $"{epoch:D}:0", FabId);
        Assert.True(result.HasGap);
        Assert.True(result.CursorAccepted);
        Assert.Equal(1, result.FirstRetainedSequence - 3);
        Assert.True(result.DroppedCount >= 1);
        var dirty = restarted.CreateDirty(result, $"{epoch:D}:0");
        Assert.NotNull(dirty);
        Assert.Equal("retention-trim", dirty!.Reason);
        Assert.True(dirty.DroppedCount >= 1);
        Assert.Equal(epoch, restarted.GetJournalEpoch(SiteId));
    }

    [Fact]
    public async Task TruncatedJournalStartsNewEpochAndKeepsAuthoritativeRecords()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "truncate-1");
        await WaitTerminalAsync(first, command.CommandId);
        var epochBefore = first.GetJournalEpoch(SiteId);
        var journalPath = JournalPath(root, epochBefore);
        var lines = File.ReadAllText(journalPath).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        File.WriteAllText(journalPath, lines[0] + "\n");

        var restarted = Service(root, options);
        var epochAfter = restarted.GetJournalEpoch(SiteId);
        Assert.NotEqual(epochBefore, epochAfter);
        var diagnostics = restarted.RecoveryDiagnostics[SiteId];
        Assert.Contains(diagnostics, diagnostic => diagnostic.Contains("journal", StringComparison.Ordinal));
        var recovered = restarted.Get(Guid.Parse(command.CommandId));
        Assert.NotNull(recovered);
        Assert.Equal(2, recovered!.Revision);
        var oldCursor = restarted.ReadJournal(SiteId, $"{epochBefore:D}:1", FabId);
        Assert.True(oldCursor.HasGap);
        Assert.False(oldCursor.CursorAccepted);
        Assert.Equal("epoch-replaced", restarted.CreateDirty(oldCursor, $"{epochBefore:D}:1")!.Reason);
        Assert.False(restarted.ReadJournal(SiteId, null, FabId).HasGap);
    }

    [Fact]
    public async Task DeletedJournalStartsNewEpochAndKeepsAuthoritativeRecords()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "delete-journal-1");
        await WaitTerminalAsync(first, command.CommandId);
        var epochBefore = first.GetJournalEpoch(SiteId);
        File.Delete(JournalPath(root, epochBefore));

        var restarted = Service(root, options);
        Assert.NotEqual(epochBefore, restarted.GetJournalEpoch(SiteId));
        Assert.NotNull(restarted.Get(Guid.Parse(command.CommandId)));
        var oldCursor = restarted.ReadJournal(SiteId, $"{epochBefore:D}:1", FabId);
        Assert.True(oldCursor.HasGap);
        Assert.Equal("epoch-replaced", restarted.CreateDirty(oldCursor, $"{epochBefore:D}:1")!.Reason);
    }

    [Fact]
    public async Task RecordNewerThanJournalIsRepairedIntoTheExistingEpoch()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "outbox-1");
        await WaitTerminalAsync(first, command.CommandId);
        var epochBefore = first.GetJournalEpoch(SiteId);
        var journalPath = JournalPath(root, epochBefore);
        var lines = File.ReadAllText(journalPath).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(3, lines.Length);
        // Simulate a crash between the durable record write and the journal append: the record has
        // three events, but the epoch/journal only acknowledge the first two.
        File.WriteAllText(journalPath, string.Join("\n", lines.Take(2)) + "\n");
        var epochPath = Path.Combine(root, SiteId.ToString("D"), "epoch.json");
        var epoch = JsonNode.Parse(File.ReadAllText(epochPath))!.AsObject();
        epoch["latestSequence"] = 2;
        epoch["journalLastSequence"] = 2;
        File.WriteAllText(epochPath, epoch.ToJsonString());

        var restarted = Service(root, options);
        Assert.Equal(epochBefore, restarted.GetJournalEpoch(SiteId));
        var journal = restarted.ReadJournal(SiteId, null, FabId);
        Assert.False(journal.HasGap);
        Assert.Equal(new long[] { 1, 2, 3 }, journal.Events.Select(envelope => envelope.Sequence).ToArray());
        Assert.Equal(2, restarted.Get(Guid.Parse(command.CommandId))!.Revision);
        Assert.Contains(restarted.RecoveryDiagnostics[SiteId], diagnostic => diagnostic == "journal-repaired-from-records");
        var resumed = RestartService(root, options).ReadJournal(SiteId, $"{epochBefore:D}:1", FabId);
        Assert.False(resumed.HasGap);
        Assert.Equal(new long[] { 2, 3 }, resumed.Events.Select(envelope => envelope.Sequence).ToArray());
    }

    [Fact]
    public async Task ConcurrentSubmissionsKeepSequencesMonotonicAcrossRestart()
    {
        var root = Root();
        var options = FastOptions();
        var service = Service(root, options);
        const int count = 40;
        var commandIds = new string[count];
        Parallel.For(0, count, index =>
        {
            var result = service.Submit(SiteId, new EquipmentCommandRequest(FabId, $"equipment-{index % 7}", "START"),
                "local-developer", $"concurrent-sequence-{index}");
            Assert.Equal(EquipmentCommandSubmitStatus.Accepted, result.Status);
            commandIds[index] = result.Command!.CommandId;
        });
        Assert.Equal(count, commandIds.Distinct(StringComparer.Ordinal).Count());
        foreach (var commandId in commandIds) await WaitTerminalAsync(service, commandId);
        var snapshot = service.ReadJournal(SiteId, null, FabId);
        var sequences = snapshot.Events.Select(envelope => envelope.Sequence).ToArray();
        Assert.Equal(sequences.Length, sequences.Distinct().Count());
        Assert.True(sequences.Zip(sequences.Skip(1), (left, right) => right > left).All(monotonic => monotonic));
        var latest = snapshot.LatestSequence;

        var restarted = Service(root, options);
        Assert.Equal(latest, restarted.ReadJournal(SiteId, null, FabId).LatestSequence);
        var page = restarted.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), 0, EquipmentCommandService.MaxJournalPageLimit);
        Assert.False(page.HasGap);
        Assert.Equal(latest, page.Events.Length);
        Assert.Equal(1, page.Events[0].Sequence);
    }

    [Fact]
    public void UnwritableStoreFailsStartupExplicitly()
    {
        var root = Root();
        Directory.CreateDirectory(root);
        var filePath = Path.Combine(root, "not-a-directory");
        File.WriteAllText(filePath, "occupied");
        var error = Assert.Throws<CommandStoreException>(() => new FileCommandStore(filePath));
        Assert.Contains("durable command store", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task IoFailureOnSubmitIsExplicitAndNeverFallsBackToMemory()
    {
        var root = Root();
        var options = FastOptions();
        var service = Service(root, options);
        var epoch = service.GetJournalEpoch(SiteId);
        var journalPath = JournalPath(root, epoch);
        File.Delete(journalPath);
        Directory.CreateDirectory(journalPath);

        var failed = service.Submit(SiteId, new EquipmentCommandRequest(FabId, "equipment-0", "START"),
            "local-developer", "io-failure-1");
        Assert.Equal(EquipmentCommandSubmitStatus.StoreUnavailable, failed.Status);
        Assert.Null(failed.Command);
        Assert.True(service.StoreUnavailable);
        Assert.Contains(service.RecoveryDiagnostics[SiteId], diagnostic => diagnostic is not null);

        // Restarting over a data directory whose epoch slot is no longer writable must fail loudly
        // instead of serving memory.
        var epochPath = Path.Combine(root, SiteId.ToString("D"), "epoch.json");
        File.Delete(epochPath);
        Directory.CreateDirectory(epochPath);
        Assert.Throws<CommandStoreException>(() => Service(root, options));
    }

    [Fact]
    public async Task Core013CombinationRestartCursorBreakEventLossAndDuplicateIdempotency()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "core-013-1");
        await WaitTerminalAsync(first, command.CommandId);
        var epochBefore = first.GetJournalEpoch(SiteId);
        var latestBefore = first.ReadJournal(SiteId, null).LatestSequence;
        // Event loss: the journal is emptied while the authoritative records and idempotency remain.
        File.WriteAllText(JournalPath(root, epochBefore), "");

        var restarted = Service(root, options);
        Assert.NotEqual(epochBefore, restarted.GetJournalEpoch(SiteId));
        var broken = restarted.ReadJournal(SiteId, $"{epochBefore:D}:{latestBefore}", FabId);
        Assert.True(broken.HasGap);
        Assert.False(broken.CursorAccepted);
        var dirty = restarted.CreateDirty(broken, $"{epochBefore:D}:{latestBefore}");
        Assert.NotNull(dirty);
        Assert.Equal("epoch-replaced", dirty!.Reason);
        // The idempotency mapping survived the cursor break: no duplicate execution.
        var replay = Submit(restarted, "equipment-0", "core-013-1");
        Assert.Equal(command.CommandId, replay.CommandId);
        Assert.Equal(0, replay.Revision);
        Assert.Equal(EquipmentCommandService.AcceptedOutcome, replay.Outcome);
        Assert.Single(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
        // The authoritative record is not reset by the replay.
        Assert.Equal(2, restarted.Get(Guid.Parse(command.CommandId))!.Revision);
        // A brand-new command receives a fresh identity in the new epoch.
        var fresh = Submit(restarted, "equipment-1", "core-013-2");
        Assert.NotEqual(command.CommandId, fresh.CommandId);
        var all = restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands;
        Assert.Equal(2, all.Length);
        Assert.Equal(2, all.Select(candidate => candidate.CommandId).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task MissingRecordIsRebuiltFromJournal()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "rebuild-record-1");
        await WaitTerminalAsync(first, command.CommandId);
        var recordPath = Path.Combine(root, SiteId.ToString("D"), "commands", command.CommandId + ".json");
        Assert.True(File.Exists(recordPath));
        File.Delete(recordPath);

        var restarted = Service(root, options);
        var rebuilt = restarted.Get(Guid.Parse(command.CommandId));
        Assert.NotNull(rebuilt);
        Assert.Equal(2, rebuilt!.Revision);
        Assert.Equal(EquipmentCommandService.SucceededOutcome, rebuilt.Outcome);
        Assert.Contains(restarted.RecoveryDiagnostics[SiteId], diagnostic => diagnostic == "record-rebuilt-from-journal");
    }

    [Fact]
    public async Task CorruptIdempotencyEntryIsDroppedWithoutBlockingStartup()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "corrupt-idempotency-1");
        await WaitTerminalAsync(first, command.CommandId);
        var idempotencyDirectory = Path.Combine(root, SiteId.ToString("D"), "idempotency");
        var entry = Assert.Single(Directory.EnumerateFiles(idempotencyDirectory, "*.json", SearchOption.AllDirectories));
        File.WriteAllText(entry, "{ not json");

        var restarted = Service(root, options);
        Assert.Contains(restarted.RecoveryDiagnostics[SiteId], diagnostic => diagnostic.StartsWith("idempotency-", StringComparison.Ordinal));
        // The authoritative command record is untouched; only the damaged idempotency mapping is gone,
        // so a retry with the same key creates a fresh command instead of failing startup.
        Assert.NotNull(restarted.Get(Guid.Parse(command.CommandId)));
        var retry = Submit(restarted, "equipment-0", "corrupt-idempotency-1");
        Assert.NotEqual(command.CommandId, retry.CommandId);
    }

    private string Root()
    {
        var root = TestDataDirectory.Create();
        roots.Add(root);
        return root;
    }

    private static EquipmentCommandService Service(string root, EquipmentCommandOptions options, TimeProvider? clock = null) =>
        new(new FileCommandStore(root), new SiteDirectory(), clock ?? TimeProvider.System, options);

    private static EquipmentCommandService RestartService(string root, EquipmentCommandOptions options) => Service(root, options);

    private static EquipmentCommandStatus Submit(EquipmentCommandService service, string equipmentId, string key)
    {
        var result = service.Submit(SiteId, new EquipmentCommandRequest(FabId, equipmentId, "START"), "local-developer", key);
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, result.Status);
        return result.Command!;
    }

    private static async Task<EquipmentCommandStatus> WaitTerminalAsync(EquipmentCommandService service, string commandId)
    {
        var id = Guid.Parse(commandId);
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            var status = service.Get(id);
            if (status is not null && status.Revision >= 2) return status;
            Assert.True(stopwatch.Elapsed < PollTimeout, "The command did not reach its terminal revision in time.");
            await Task.Delay(10);
        }
    }

    private static string JournalPath(string root, Guid epoch) =>
        Path.Combine(root, SiteId.ToString("D"), "journal", epoch.ToString("D") + ".jsonl");

    private static EquipmentCommandOptions FastOptions(EquipmentCommandOptions? source = null) => new()
    {
        ExecutingDelay = TimeSpan.FromMilliseconds(5),
        SucceededDelay = TimeSpan.FromMilliseconds(10),
        TerminalTtl = source?.TerminalTtl ?? TimeSpan.FromMinutes(5),
        MaxTerminalCommands = source?.MaxTerminalCommands ?? 512,
        MaxJournalEventsPerSite = source?.MaxJournalEventsPerSite ?? 4096,
        MaxIdempotencyEntries = source?.MaxIdempotencyEntries ?? 4096
    };
}