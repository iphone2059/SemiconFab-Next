using System.Diagnostics;
using Fab.App;
using Fab.Contracts;
using Fab.Site;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Fab.Tests;

/// <summary>
/// ADR-012 transactional durable store coverage: restart over the same SQLite database,
/// idempotency replay, exact journal cursor replay, retention gaps, epoch replacement after a
/// Development store reset, concurrent sequence monotonicity, WAL/atomic-commit invariants and
/// explicit IO failure. The crash-boundary matrix lives in <see cref="CommandFaultInjectionTests"/>.
/// Every test uses an OS temporary directory, never the repository .local/data.
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
        const long cursor = 1;
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
        Assert.Equal(4, result.FirstRetainedSequence);
        Assert.True(result.DroppedCount >= 3);
        var dirty = restarted.CreateDirty(result, $"{epoch:D}:0");
        Assert.NotNull(dirty);
        Assert.Equal("retention-trim", dirty!.Reason);
        Assert.True(dirty.DroppedCount >= 3);
        Assert.Equal(epoch, restarted.GetJournalEpoch(SiteId));
    }

    [Fact]
    public async Task DatabaseResetReplacesEpochAndRejectsOldCursor()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var command = Submit(first, "equipment-0", "reset-epoch-1");
        await WaitTerminalAsync(first, command.CommandId);
        var epochBefore = first.GetJournalEpoch(SiteId);
        var latestBefore = first.ReadJournal(SiteId, null).LatestSequence;
        TestDataDirectory.ResetDatabase(root);

        var restarted = Service(root, options);
        var epochAfter = restarted.GetJournalEpoch(SiteId);
        Assert.NotEqual(epochBefore, epochAfter);
        Assert.Null(restarted.Get(Guid.Parse(command.CommandId)));
        Assert.Empty(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
        var oldCursor = restarted.ReadJournal(SiteId, $"{epochBefore:D}:{latestBefore}", FabId);
        Assert.True(oldCursor.HasGap);
        Assert.False(oldCursor.CursorAccepted);
        Assert.Equal("epoch-replaced", restarted.CreateDirty(oldCursor, $"{epochBefore:D}:{latestBefore}")!.Reason);
        Assert.False(restarted.ReadJournal(SiteId, null, FabId).HasGap);

        var fresh = Submit(restarted, "equipment-0", "reset-epoch-2");
        Assert.NotEqual(command.CommandId, fresh.CommandId);
        Assert.Single(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
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
        Assert.Equal(count * 3, sequences.Length);
        Assert.Equal(sequences.OrderBy(sequence => sequence), sequences);
        var latest = snapshot.LatestSequence;

        var restarted = Service(root, options);
        Assert.Equal(latest, restarted.ReadJournal(SiteId, null, FabId).LatestSequence);
        var page = restarted.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), restarted.GetJournalEpoch(SiteId), 0,
            EquipmentCommandService.MaxJournalPageLimit);
        Assert.NotNull(page.Page);
        Assert.False(page.Page!.HasGap);
        Assert.Equal(latest, page.Page.Events.Length);
        Assert.Equal(1, page.Page.Events[0].Sequence);
        Assert.Equal(latest, page.Page.NextAfterSequence);
    }

    [Fact]
    public void UnwritableStoreFailsStartupExplicitly()
    {
        var root = Root();
        Directory.CreateDirectory(root);
        var databasePath = TestDataDirectory.DatabasePath(root);
        Directory.CreateDirectory(databasePath);
        var error = Assert.Throws<CommandStoreException>(() => new SqliteCommandStore(databasePath));
        Assert.Contains("command store", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void IoFailureOnSubmitIsExplicitAndNeverFallsBackToMemory()
    {
        var root = Root();
        var options = FastOptions();
        var service = Service(root, options);
        TestDataDirectory.ResetDatabase(root);
        Directory.CreateDirectory(TestDataDirectory.DatabasePath(root));

        var failed = service.Submit(SiteId, new EquipmentCommandRequest(FabId, "equipment-0", "START"),
            "local-developer", "io-failure-1");
        Assert.Equal(EquipmentCommandSubmitStatus.StoreUnavailable, failed.Status);
        Assert.Null(failed.Command);
        Assert.True(service.StoreUnavailable);
        Assert.NotEmpty(service.RecoveryDiagnostics[SiteId]);

        // Restarting over the broken database path must fail loudly instead of serving memory.
        Assert.Throws<CommandStoreException>(() => Service(root, options));
    }

    [Fact]
    public async Task SqliteDatabaseUsesWalAndCommitsCommandIdempotencyJournalTogether()
    {
        var root = Root();
        var options = FastOptionsLong();
        var service = Service(root, options);
        var first = Submit(service, "equipment-0", "wal-1");
        var second = Submit(service, "equipment-1", "wal-2");
        await Task.Yield();

        Assert.Equal(2, CountRows(root, "commands"));
        Assert.Equal(2, CountRows(root, "idempotency"));
        Assert.Equal(2, CountRows(root, "journal"));
        Assert.Equal("wal", Scalar(root, "PRAGMA journal_mode;"));
        Assert.Equal("2", Scalar(root, "SELECT COUNT(*) FROM commands WHERE terminal = 0;"));

        var restarted = Service(root, options);
        var replayFirst = Submit(restarted, "equipment-0", "wal-1");
        var replaySecond = Submit(restarted, "equipment-1", "wal-2");
        Assert.Equal(first.CommandId, replayFirst.CommandId);
        Assert.Equal(second.CommandId, replaySecond.CommandId);
        Assert.Equal(2, CountRows(root, "commands"));
    }

    [Fact]
    public async Task TamperedInvariantFailsStartupExplicitly()
    {
        var root = Root();
        var options = FastOptionsLong();
        var service = Service(root, options);
        Submit(service, "equipment-0", "tamper-1");
        await Task.Yield();
        SqliteConnection.ClearAllPools();
        using (var connection = new SqliteConnection($"Data Source={TestDataDirectory.DatabasePath(root)}"))
        {
            connection.Open();
            using var delete = connection.CreateCommand();
            delete.CommandText = "DELETE FROM idempotency;";
            Assert.Equal(1, delete.ExecuteNonQuery());
        }
        var error = Assert.Throws<CommandStoreException>(() => Service(root, options));
        Assert.Contains("inconsistent", error.InnerException?.Message ?? error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Core013CrashCommitRetryAndEpochResetCombination()
    {
        var root = Root();
        var options = FastOptionsLong();
        var injector = new TestFaultInjector { ThrowAt = CommandStoreFaultPoints.AfterCommitBeforeResponse };
        var first = new EquipmentCommandService(new SqliteCommandStore(TestDataDirectory.DatabasePath(root), injector),
            new SiteDirectory(), TimeProvider.System, options);
        // The transaction commits but the simulated crash prevents the 202 response from reaching
        // the client. A retry with the same key + payload must replay the same commandId.
        Assert.Throws<InjectedCommandStoreFaultException>(() =>
            Submit(first, "equipment-0", "core-013-crash-1"));
        injector.ThrowAt = null;
        var restarted = Service(root, options);
        var replay = Submit(restarted, "equipment-0", "core-013-crash-1");
        Assert.Equal(0, replay.Revision);
        Assert.Equal(EquipmentCommandService.AcceptedOutcome, replay.Outcome);
        Assert.Single(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
        Assert.NotNull(restarted.Get(Guid.Parse(replay.CommandId)));

        // A Development store reset replaces the epoch: old cursors must be rejected explicitly and
        // the old idempotency guarantee does not apply outside the (reset) retention window.
        var epochBefore = restarted.GetJournalEpoch(SiteId);
        var latestBefore = restarted.ReadJournal(SiteId, null).LatestSequence;
        TestDataDirectory.ResetDatabase(root);
        var reset = Service(root, options);
        Assert.NotEqual(epochBefore, reset.GetJournalEpoch(SiteId));
        var broken = reset.ReadJournal(SiteId, $"{epochBefore:D}:{latestBefore}", FabId);
        Assert.True(broken.HasGap);
        Assert.Equal("epoch-replaced", reset.CreateDirty(broken, $"{epochBefore:D}:{latestBefore}")!.Reason);
        Assert.Null(reset.Get(Guid.Parse(replay.CommandId)));
        var fresh = Submit(reset, "equipment-0", "core-013-crash-1");
        Assert.Equal(0, fresh.Revision);
        Assert.Single(reset.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
    }

    [Fact]
    public void EmptySiteJournalPageIsNotGap()
    {
        var root = Root();
        var service = Service(root, FastOptions());
        var epoch = service.GetJournalEpoch(SiteId);
        var page = service.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), epoch, 0,
            EquipmentCommandService.DefaultJournalPageLimit);
        Assert.NotNull(page.Page);
        Assert.False(page.Page!.HasGap);
        Assert.Empty(page.Page.Events);
        Assert.Equal(1, page.Page.FirstRetainedSequence);
        Assert.Equal(0, page.Page.LatestSequence);
        Assert.Equal(0, page.Page.NextAfterSequence);

        // A legitimately empty Site must also replay without a gap for the initial cursor.
        var replay = service.ReadJournal(SiteId, $"{epoch:D}:0", FabId);
        Assert.False(replay.HasGap);
        Assert.Equal(1, replay.FirstRetainedSequence);
        Assert.Equal(0, replay.LatestSequence);
        Assert.Null(service.CreateDirty(replay, $"{epoch:D}:0"));
    }

    [Fact]
    public async Task CompletelyPrunedRetainedWindowReportsGap()
    {
        var root = Root();
        var clock = new ManualClock();
        var options = FastOptions(new EquipmentCommandOptions { TerminalTtl = TimeSpan.FromSeconds(30) });
        var service = Service(root, options, clock);
        var first = Submit(service, "equipment-0", "empty-window-1");
        await WaitTerminalAsync(service, first.CommandId);
        var second = Submit(service, "equipment-1", "empty-window-2");
        await WaitTerminalAsync(service, second.CommandId);
        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(2, service.PruneTerminalCommands());

        var epoch = service.GetJournalEpoch(SiteId);
        var page = service.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), epoch, 0,
            EquipmentCommandService.DefaultJournalPageLimit);
        Assert.NotNull(page.Page);
        Assert.True(page.Page!.HasGap);
        Assert.Empty(page.Page.Events);
        Assert.Equal(6, page.Page.LatestSequence);
        Assert.Equal(7, page.Page.FirstRetainedSequence); // latest + 1 for a fully pruned window.
        Assert.Equal(6, page.Page.NextAfterSequence); // the scanned Site watermark, not the old cursor.

        // The exact boundary before the (now empty) retained window is not a gap.
        var boundary = service.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), epoch, 6,
            EquipmentCommandService.DefaultJournalPageLimit);
        Assert.NotNull(boundary.Page);
        Assert.False(boundary.Page!.HasGap);
        Assert.Empty(boundary.Page.Events);
        Assert.Equal(6, boundary.Page.NextAfterSequence);

        // SSE replay of the same old cursor must be an explicit gap, never a silent empty replay.
        var replay = service.ReadJournal(SiteId, $"{epoch:D}:0", FabId);
        Assert.True(replay.HasGap);
        Assert.True(replay.CursorAccepted);
        Assert.Equal(6, replay.DroppedCount);
        Assert.NotNull(service.CreateDirty(replay, $"{epoch:D}:0"));
        var caughtUp = service.ReadJournal(SiteId, $"{epoch:D}:6", FabId);
        Assert.False(caughtUp.HasGap);
    }

    [Fact]
    public async Task InteriorRetentionHoleIsReportedAsGap()
    {
        var root = Root();
        var options = FastOptions();
        var first = Service(root, options);
        var commands = new List<string>();
        for (var index = 0; index < 3; index++)
        {
            var command = Submit(first, $"equipment-{index}", $"hole-{index}");
            commands.Add(command.CommandId);
            // Wait for the terminal revision so each command contributes exactly three ordered events
            // (accepted/executing/succeeded), giving Site sequences 1..3, 4..6 and 7..9.
            await WaitTerminalAsync(first, command.CommandId);
        }
        Assert.Equal(9, first.ReadJournal(SiteId, null).LatestSequence);

        // Simulate a durable retention transaction that prunes a middle command (the other two stay).
        // Retention holes are contract-legal inside the cursor window; the page must mark them as gaps.
        var store = new SqliteCommandStore(TestDataDirectory.DatabasePath(root));
        var recovered = store.Recover(SiteId);
        Assert.Equal(9, recovered.LatestSequence);
        store.CommitRetention(SiteId, new CommandRetentionUpdate(1, [commands[1]]));

        var restarted = Service(root, options);
        var page = restarted.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), restarted.GetJournalEpoch(SiteId), 0,
            EquipmentCommandService.DefaultJournalPageLimit);
        Assert.NotNull(page.Page);
        Assert.True(page.Page!.HasGap);
        Assert.Equal(1, page.Page.FirstRetainedSequence);
        Assert.Equal(9, page.Page.LatestSequence);
        Assert.Equal(new long[] { 1, 2, 3, 7, 8, 9 }, page.Page.Events.Select(item => item.Sequence).ToArray());
        Assert.Equal(9, page.Page.NextAfterSequence);

        // The exact boundary before the hole is a gap (the hole is inside the requested range).
        var boundary = restarted.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), restarted.GetJournalEpoch(SiteId), 3,
            EquipmentCommandService.DefaultJournalPageLimit);
        Assert.True(boundary.Page!.HasGap);
        Assert.Equal(new long[] { 7, 8, 9 }, boundary.Page.Events.Select(item => item.Sequence).ToArray());

        // A cursor already past the hole replays the contiguous tail without a gap.
        var afterHole = restarted.ReadCommandJournalPage(SiteId, Guid.Parse(FabId), restarted.GetJournalEpoch(SiteId), 6,
            EquipmentCommandService.DefaultJournalPageLimit);
        Assert.False(afterHole.Page!.HasGap);
        Assert.Equal(new long[] { 7, 8, 9 }, afterHole.Page.Events.Select(item => item.Sequence).ToArray());
    }

    private string Root()
    {
        var root = TestDataDirectory.Create();
        roots.Add(root);
        return root;
    }

    private static EquipmentCommandService Service(string root, EquipmentCommandOptions options, TimeProvider? clock = null) =>
        new(new SqliteCommandStore(TestDataDirectory.DatabasePath(root)), new SiteDirectory(), clock ?? TimeProvider.System, options);

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

    private static int CountRows(string root, string table)
    {
        using var connection = new SqliteConnection($"Data Source={TestDataDirectory.DatabasePath(root)}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {table};";
        return Convert.ToInt32(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Scalar(string root, string sql)
    {
        using var connection = new SqliteConnection($"Data Source={TestDataDirectory.DatabasePath(root)}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToString(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) ?? "";
    }

    private static EquipmentCommandOptions FastOptions(EquipmentCommandOptions? source = null) => new()
    {
        ExecutingDelay = TimeSpan.FromMilliseconds(5),
        SucceededDelay = TimeSpan.FromMilliseconds(10),
        TerminalTtl = source?.TerminalTtl ?? TimeSpan.FromMinutes(5),
        MaxTerminalCommands = source?.MaxTerminalCommands ?? 512,
        MaxJournalEventsPerSite = source?.MaxJournalEventsPerSite ?? 4096
    };

    /// <summary>Long simulated delays keep commands at revision 0 so tests can inspect the accepted transaction.</summary>
    private static EquipmentCommandOptions FastOptionsLong(EquipmentCommandOptions? source = null) => new()
    {
        ExecutingDelay = TimeSpan.FromHours(1),
        SucceededDelay = TimeSpan.FromHours(2),
        TerminalTtl = source?.TerminalTtl ?? TimeSpan.FromMinutes(5),
        MaxTerminalCommands = source?.MaxTerminalCommands ?? 512,
        MaxJournalEventsPerSite = source?.MaxJournalEventsPerSite ?? 4096
    };

    private sealed class ManualClock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.Parse("2026-10-30T00:00:00Z");

        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan by) => now += by;
    }
}
