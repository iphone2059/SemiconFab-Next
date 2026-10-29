using System.Diagnostics;
using Fab.App;
using Fab.Site;
using Xunit;

namespace Fab.Tests;

/// <summary>Deterministic coverage for command memory retention (active retention, TTL/max pruning, clean replay).</summary>
public sealed class CommandRetentionTests
{
    private static readonly Guid SiteId = SiteDirectory.DemoSiteId;
    private static readonly string FabId = SiteDirectory.CreateFab(1).Id.ToString("D");

    [Fact]
    public void ActiveCommandsAreRetainedRegardlessOfTtlAndTerminalCap()
    {
        var clock = new ManualClock();
        var service = Service(clock, new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            TerminalTtl = TimeSpan.FromTicks(1),
            MaxTerminalCommands = 1
        });
        var command = Submit(service, "equipment-0", "active-1");
        clock.Advance(TimeSpan.FromHours(5));

        Assert.Equal(0, service.PruneTerminalCommands());
        var current = service.Get(Guid.Parse(command.CommandId));
        Assert.NotNull(current);
        Assert.Equal(0, current!.Revision);
    }

    [Fact]
    public async Task TerminalCommandsArePrunedAfterConfiguredTtl()
    {
        var clock = new ManualClock();
        var service = Service(clock, FastOptions(new EquipmentCommandOptions { TerminalTtl = TimeSpan.FromSeconds(30) }));
        var command = Submit(service, "equipment-0", "ttl-1");
        var commandId = Guid.Parse(command.CommandId);
        await WaitForRevisionAsync(service, commandId, 2, TimeSpan.FromSeconds(5));
        Assert.NotNull(service.Get(commandId));

        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(1, service.PruneTerminalCommands());
        Assert.Null(service.Get(commandId));
    }

    [Fact]
    public async Task OldestTerminalCommandsArePrunedBeyondConfiguredMaximum()
    {
        var service = Service(TimeProvider.System, FastOptions(new EquipmentCommandOptions { MaxTerminalCommands = 1 }));
        var first = Submit(service, "equipment-0", "cap-1");
        await WaitForRevisionAsync(service, Guid.Parse(first.CommandId), 2, TimeSpan.FromSeconds(5));
        var second = Submit(service, "equipment-1", "cap-2");
        await WaitForRevisionAsync(service, Guid.Parse(second.CommandId), 2, TimeSpan.FromSeconds(5));

        await WaitUntilAsync(() => service.Get(Guid.Parse(first.CommandId)) is null, TimeSpan.FromSeconds(5));
        Assert.NotNull(service.Get(Guid.Parse(second.CommandId)));
    }

    [Fact]
    public async Task IdempotencyReplayAfterPruneCreatesFreshCommand()
    {
        var clock = new ManualClock();
        var service = Service(clock, FastOptions(new EquipmentCommandOptions { TerminalTtl = TimeSpan.FromSeconds(30) }));
        var request = new EquipmentCommandRequest(FabId, "equipment-0", "START");
        var first = service.Submit(SiteId, request, "local-developer", "replay-prune-1");
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, first.Status);
        await WaitForRevisionAsync(service, Guid.Parse(first.Command!.CommandId), 2, TimeSpan.FromSeconds(5));

        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(1, service.PruneTerminalCommands());
        Assert.Null(service.Get(Guid.Parse(first.Command!.CommandId)));

        // The pruned idempotency entry must not replay a dead commandId; a retry creates a fresh command.
        var replay = service.Submit(SiteId, request, "local-developer", "replay-prune-1");
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, replay.Status);
        Assert.NotEqual(first.Command!.CommandId, replay.Command!.CommandId);
    }

    [Fact]
    public void InvalidRetentionOptionsFailFast()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Service(TimeProvider.System, new EquipmentCommandOptions { TerminalTtl = TimeSpan.Zero }));
        Assert.Throws<ArgumentOutOfRangeException>(() => Service(TimeProvider.System, new EquipmentCommandOptions { MaxTerminalCommands = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => Service(TimeProvider.System, new EquipmentCommandOptions { MaxJournalEventsPerSite = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => Service(TimeProvider.System, new EquipmentCommandOptions { ExecutingDelay = TimeSpan.Zero }));
        Assert.Throws<ArgumentOutOfRangeException>(() => Service(TimeProvider.System,
            new EquipmentCommandOptions { ExecutingDelay = TimeSpan.FromMilliseconds(200), SucceededDelay = TimeSpan.FromMilliseconds(100) }));
    }

    private static EquipmentCommandService Service(TimeProvider clock, EquipmentCommandOptions options) =>
        new(TestDataDirectory.Store(), new SiteDirectory(), clock, options);

    private static EquipmentCommandOptions FastOptions(EquipmentCommandOptions options) => new()
    {
        ExecutingDelay = TimeSpan.FromMilliseconds(10),
        SucceededDelay = TimeSpan.FromMilliseconds(20),
        TerminalTtl = options.TerminalTtl,
        MaxTerminalCommands = options.MaxTerminalCommands,
        MaxJournalEventsPerSite = options.MaxJournalEventsPerSite,
        MaxIdempotencyEntries = options.MaxIdempotencyEntries
    };

    private static EquipmentCommandStatus Submit(EquipmentCommandService service, string equipmentId, string key)
    {
        var result = service.Submit(SiteId, new EquipmentCommandRequest(FabId, equipmentId, "START"), "local-developer", key);
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, result.Status);
        return result.Command!;
    }

    private static async Task WaitForRevisionAsync(EquipmentCommandService service, Guid commandId, int expectedRevision, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            var status = service.Get(commandId);
            if (status is not null && status.Revision >= expectedRevision) return;
            Assert.True(stopwatch.Elapsed < timeout, "The command did not reach the expected revision in time.");
            await Task.Delay(20);
        }
    }

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (!condition())
        {
            Assert.True(stopwatch.Elapsed < timeout, "The condition was not reached in time.");
            await Task.Delay(20);
        }
    }

    private sealed class ManualClock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.Parse("2026-10-27T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan by) => now += by;
    }
}
