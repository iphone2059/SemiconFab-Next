using System.Diagnostics;
using Fab.App;
using Fab.Contracts;
using Fab.Site;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Fab.Tests;

/// <summary>
/// ADR-012 2.3 / matrix 3 crash-boundary matrix. For every durable-transaction boundary the test
/// injects a crash and then reopens the store (new instance over the same SQLite database):
///  - pre-commit points must leave no partial state and the client may create exactly one command
///    on retry (the 202 was never observed);
///  - post-commit points must replay the same commandId/revision/outcome on retry (the commit is
///    durable even though the 202 was lost);
///  - every case must satisfy the on-disk invariants (no command without idempotency, no journal
///    event without command, journal revision == command revision).
/// No test accepts "same key => new command" as a passing outcome.
/// </summary>
public sealed class CommandFaultInjectionTests : IDisposable
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

    public static TheoryData<string> PreCommitPoints => new()
    {
        CommandStoreFaultPoints.AfterCommandInsert,
        CommandStoreFaultPoints.AfterIdempotencyInsert,
        CommandStoreFaultPoints.AfterJournalInsert,
        CommandStoreFaultPoints.BeforeCommit
    };

    public static TheoryData<string> PostCommitPoints => new()
    {
        CommandStoreFaultPoints.AfterCommitBeforeResponse,
        CommandStoreFaultPoints.BeforeCommitReturn
    };

    [Theory]
    [MemberData(nameof(PreCommitPoints))]
    public void PreCommitFaultLeavesNoPartialStateAndRetryCreatesExactlyOneCommand(string point)
    {
        var root = Root();
        var injector = new TestFaultInjector { ThrowAt = point };
        var service = Service(root, injector, LongOptions());
        var key = "fault-" + point;
        Assert.Throws<InjectedCommandStoreFaultException>(() => Submit(service, "equipment-0", key));

        TestDataDirectory.ResetDatabasePools();
        Assert.Equal(0, CountRows(root, "commands"));
        Assert.Equal(0, CountRows(root, "idempotency"));
        Assert.Equal(0, CountRows(root, "journal"));
        Assert.Equal(0L, ScalarInt64(root, "SELECT latest_sequence FROM site_state LIMIT 1;"));
        AssertDatabaseInvariants(root);

        var restarted = Service(root, null, LongOptions());
        Assert.Empty(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
        Assert.Equal(0, restarted.ReadJournal(SiteId, null).LatestSequence);
        var accepted = Submit(restarted, "equipment-0", key);
        Assert.Single(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
        Assert.Equal(1, restarted.ReadJournal(SiteId, null).LatestSequence);
        Assert.Equal(1, CountRows(root, "commands"));
        Assert.Equal(1, CountRows(root, "idempotency"));
        Assert.Equal(1, CountRows(root, "journal"));
        AssertDatabaseInvariants(root);
        // The 202-confirmed command now replays the same identity.
        var replay = Submit(restarted, "equipment-0", key);
        Assert.Equal(accepted.CommandId, replay.CommandId);
        Assert.Equal(0, replay.Revision);
        Assert.Equal(EquipmentCommandService.AcceptedOutcome, replay.Outcome);
        Assert.Equal(accepted.OccurredAt, replay.OccurredAt);
        Assert.Equal(1, CountRows(root, "commands"));
    }

    [Theory]
    [MemberData(nameof(PostCommitPoints))]
    public void PostCommitFaultKeepsDurableCommitAndRetryReplaysSameCommand(string point)
    {
        var root = Root();
        var injector = new TestFaultInjector { ThrowAt = point };
        var service = Service(root, injector, LongOptions());
        var key = "fault-post-" + point;
        Assert.Throws<InjectedCommandStoreFaultException>(() => Submit(service, "equipment-0", key));

        TestDataDirectory.ResetDatabasePools();
        Assert.Equal(1, CountRows(root, "commands"));
        Assert.Equal(1, CountRows(root, "idempotency"));
        Assert.Equal(1, CountRows(root, "journal"));
        AssertDatabaseInvariants(root);

        var restarted = Service(root, null, LongOptions());
        var listing = restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1);
        Assert.Single(listing.Commands);
        var committedCommandId = listing.Commands[0].CommandId;
        Assert.Equal(1, restarted.ReadJournal(SiteId, null).LatestSequence);
        var replay = Submit(restarted, "equipment-0", key);
        Assert.Equal(committedCommandId, replay.CommandId);
        Assert.Equal(0, replay.Revision);
        Assert.Equal(EquipmentCommandService.AcceptedOutcome, replay.Outcome);
        Assert.Equal(1, CountRows(root, "commands"));
        AssertDatabaseInvariants(root);
    }

    [Fact]
    public void InjectorRecordsCommitBoundaryOrder()
    {
        var root = Root();
        var injector = new TestFaultInjector();
        var service = Service(root, injector, LongOptions());
        Submit(service, "equipment-0", "fault-order-1");
        Assert.Equal(new[]
        {
            CommandStoreFaultPoints.AfterCommandInsert,
            CommandStoreFaultPoints.AfterIdempotencyInsert,
            CommandStoreFaultPoints.AfterJournalInsert,
            CommandStoreFaultPoints.BeforeCommit,
            CommandStoreFaultPoints.AfterCommitBeforeResponse,
            CommandStoreFaultPoints.BeforeCommitReturn
        }, injector.Reached);
    }

    [Fact]
    public async Task DuringPruneFaultRollsBackTheWholeRetentionTransaction()
    {
        var root = Root();
        var clock = new ManualClock();
        var injector = new TestFaultInjector();
        var service = Service(root, injector, FastOptions(), clock);
        var first = Submit(service, "equipment-0", "prune-fault-1");
        await WaitTerminalAsync(service, first.CommandId);
        var second = Submit(service, "equipment-1", "prune-fault-2");
        await WaitTerminalAsync(service, second.CommandId);
        Assert.Equal(2, CountRows(root, "commands"));
        Assert.Equal(6, CountRows(root, "journal"));
        clock.Advance(TimeSpan.FromSeconds(31));

        injector.ThrowAt = CommandStoreFaultPoints.DuringPrune;
        Assert.Throws<InjectedCommandStoreFaultException>(() => service.PruneTerminalCommands());
        TestDataDirectory.ResetDatabasePools();
        // The retention transaction rolled back completely: nothing was pruned and the journal,
        // command and idempotency rows are still consistent.
        Assert.Equal(2, CountRows(root, "commands"));
        Assert.Equal(2, CountRows(root, "idempotency"));
        Assert.Equal(6, CountRows(root, "journal"));
        Assert.Equal(6L, ScalarInt64(root, "SELECT latest_sequence FROM site_state LIMIT 1;"));
        AssertDatabaseInvariants(root);

        // A restart re-applies retention and now succeeds in one transaction.
        var restarted = Service(root, null, FastOptions(), clock);
        Assert.Empty(restarted.ListFabCommands(SiteId, Guid.Parse(FabId), EquipmentCommandService.StatusAll, -1).Commands);
        TestDataDirectory.ResetDatabasePools();
        Assert.Equal(0, CountRows(root, "commands"));
        Assert.Equal(0, CountRows(root, "journal"));
    }

    private string Root()
    {
        var root = TestDataDirectory.Create();
        roots.Add(root);
        return root;
    }

    private static EquipmentCommandService Service(string root, ICommandStoreFaultInjector? injector,
        EquipmentCommandOptions options, TimeProvider? clock = null) =>
        new(new SqliteCommandStore(TestDataDirectory.DatabasePath(root), injector), new SiteDirectory(),
            clock ?? TimeProvider.System, options);

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

    /// <summary>On-disk invariants ADR-012 2.2: every command has idempotency, every journal event has a command, revisions agree.</summary>
    private static void AssertDatabaseInvariants(string root)
    {
        TestDataDirectory.ResetDatabasePools();
        Assert.Equal(0, CountRows(root, "SELECT COUNT(*) FROM commands c LEFT JOIN idempotency i ON i.command_id = c.command_id WHERE i.command_id IS NULL;"));
        Assert.Equal(0, CountRows(root, "SELECT COUNT(*) FROM journal j LEFT JOIN commands c ON c.command_id = j.command_id WHERE c.command_id IS NULL;"));
        Assert.Equal(0, CountRows(root, "SELECT COUNT(*) FROM commands c WHERE c.revision <> (SELECT MAX(j.revision) FROM journal j WHERE j.command_id = c.command_id);"));
    }

    private static int CountRows(string root, string tableOrSql)
    {
        var sql = tableOrSql.Contains(' ') ? tableOrSql : $"SELECT COUNT(*) FROM {tableOrSql};";
        using var connection = new SqliteConnection($"Data Source={TestDataDirectory.DatabasePath(root)}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt32(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static long ScalarInt64(string root, string sql)
    {
        using var connection = new SqliteConnection($"Data Source={TestDataDirectory.DatabasePath(root)}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static EquipmentCommandOptions FastOptions() => new()
    {
        ExecutingDelay = TimeSpan.FromMilliseconds(5),
        SucceededDelay = TimeSpan.FromMilliseconds(10),
        TerminalTtl = TimeSpan.FromSeconds(30),
        MaxTerminalCommands = 512,
        MaxJournalEventsPerSite = 4096
    };

    private static EquipmentCommandOptions LongOptions() => new()
    {
        ExecutingDelay = TimeSpan.FromHours(1),
        SucceededDelay = TimeSpan.FromHours(2)
    };

    private sealed class ManualClock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.Parse("2026-10-30T00:00:00Z");

        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan by) => now += by;
    }
}
