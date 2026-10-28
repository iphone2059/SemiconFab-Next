using Fab.App;
using Fab.Site;
using Xunit;

namespace Fab.Tests;

/// <summary>Unit coverage for the command journal cursor/epoch/replay-gap semantics used by the SSE stream.</summary>
public sealed class CommandJournalTests
{
    private static readonly Guid SiteId = SiteDirectory.DemoSiteId;
    private static readonly string FabId = SiteDirectory.CreateFab(1).Id.ToString("D");

    [Fact]
    public void FreshReadReplaysRetainedJournalWithoutGap()
    {
        var service = Service();
        var command = Submit(service, "equipment-0", "key-1");
        var result = service.ReadJournal(SiteId, null);

        Assert.False(result.HasGap);
        Assert.False(result.CursorAccepted);
        Assert.NotEmpty(result.Events);
        Assert.Equal(1, result.Events[0].Sequence);
        Assert.Equal(result.LatestSequence, result.Events[^1].Sequence);
        Assert.All(result.Events, envelope => Assert.Equal(command.CommandId, envelope.Payload.CommandId));
        Assert.Equal(result.Events[^1].Sequence, result.LatestSequence);
        Assert.Equal(1, result.FirstRetainedSequence);
    }

    [Fact]
    public void ValidCursorResumesAfterRequestedSequenceWithoutGap()
    {
        var service = Service();
        Submit(service, "equipment-0", "key-1");

        var fromStart = service.ReadJournal(SiteId, $"{service.JournalEpoch:D}:0");
        Assert.False(fromStart.HasGap);
        Assert.True(fromStart.CursorAccepted);
        Assert.Equal(0, fromStart.RequestedSequence);
        Assert.NotEmpty(fromStart.Events);
        Assert.All(fromStart.Events, envelope => Assert.True(envelope.Sequence > 0));

        var snapshot = service.ReadJournal(SiteId, null);
        var cursor = $"{service.JournalEpoch:D}:{snapshot.LatestSequence}";
        var fromTail = service.ReadJournal(SiteId, cursor);
        Assert.False(fromTail.HasGap);
        Assert.True(fromTail.CursorAccepted);
        Assert.Equal(snapshot.LatestSequence, fromTail.RequestedSequence);
        Assert.All(fromTail.Events, envelope => Assert.True(envelope.Sequence > snapshot.LatestSequence));
    }

    [Fact]
    public void ForeignEpochReportsGapAndReplaysRetainedEvents()
    {
        var service = Service();
        Submit(service, "equipment-0", "key-1");
        var foreignEpoch = Guid.NewGuid();
        var lastEventId = $"{foreignEpoch:D}:1";

        var result = service.ReadJournal(SiteId, lastEventId);
        Assert.True(result.HasGap);
        Assert.False(result.CursorAccepted);
        Assert.Equal(1, result.RequestedSequence);
        Assert.NotEmpty(result.Events);

        var gap = service.CreateReplayGap(result, lastEventId);
        Assert.True(gap.ReplayGap);
        Assert.Equal(EquipmentCommandService.CommandResultTopic, gap.Topic);
        Assert.Equal(service.JournalEpoch.ToString("D"), gap.Epoch);
        Assert.NotEqual(foreignEpoch.ToString("D"), gap.Epoch);
        Assert.Equal(lastEventId, gap.RequestedLastEventId);
        Assert.Equal(result.FirstRetainedSequence, gap.FirstRetainedSequence);
        Assert.Equal(result.LatestSequence, gap.LatestSequence);
        Assert.True(DateTimeOffset.TryParse(gap.OccurredAt, out _));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-cursor")]
    [InlineData("some-guid")]
    [InlineData("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:")]
    [InlineData(":1")]
    [InlineData("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:-1")]
    public void MalformedCursorReportsGap(string? lastEventId)
    {
        var service = Service();
        Submit(service, "equipment-0", "key-1");
        if (string.IsNullOrWhiteSpace(lastEventId))
        {
            Assert.False(service.ReadJournal(SiteId, lastEventId).HasGap);
            return;
        }
        var result = service.ReadJournal(SiteId, lastEventId);
        Assert.True(result.HasGap);
        Assert.False(result.CursorAccepted);
        Assert.NotEmpty(result.Events);
    }

    [Fact]
    public void CursorOlderThanRetainedJournalReportsGap()
    {
        var service = Service(new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxJournalEventsPerSite = 2
        });
        Submit(service, "equipment-0", "key-1");
        Submit(service, "equipment-1", "key-2");
        Submit(service, "equipment-2", "key-3");

        var result = service.ReadJournal(SiteId, $"{service.JournalEpoch:D}:0");
        Assert.True(result.HasGap);
        Assert.True(result.CursorAccepted);
        Assert.Equal(2, result.FirstRetainedSequence);
        Assert.Equal(new long[] { 2, 3 }, result.Events.Select(envelope => envelope.Sequence).ToArray());

        // The exact boundary before the retained window is still resumable.
        var boundary = service.ReadJournal(SiteId, $"{service.JournalEpoch:D}:{result.FirstRetainedSequence - 1}");
        Assert.False(boundary.HasGap);
        Assert.Equal(new long[] { 2, 3 }, boundary.Events.Select(envelope => envelope.Sequence).ToArray());
    }

    [Fact]
    public void EpochIsStablePerServiceInstanceAndDiffersAcrossInstances()
    {
        var first = Service();
        var second = Service();
        Assert.NotEqual(Guid.Empty, first.JournalEpoch);
        Assert.Equal(first.JournalEpoch, first.JournalEpoch);
        Assert.NotEqual(first.JournalEpoch, second.JournalEpoch);
    }

    [Theory]
    [InlineData("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0", true, 0)]
    [InlineData("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:42", true, 42)]
    [InlineData(" AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA:42 ", true, 42)]
    [InlineData("", false, 0)]
    [InlineData("nope", false, 0)]
    [InlineData("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", false, 0)]
    [InlineData("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:x", false, 0)]
    public void LastEventIdParsing(string value, bool expected, long expectedSequence)
    {
        Assert.Equal(expected, EquipmentCommandService.TryParseLastEventId(value, out var epoch, out var sequence));
        if (!expected) return;
        Assert.Equal(expectedSequence, sequence);
        Assert.NotEqual(Guid.Empty, epoch);
    }

    [Fact]
    public void CursorAheadOfLatestReportsGapAndReplaysRetainedEvents()
    {
        var service = Service();
        var command = Submit(service, "equipment-0", "key-1");
        var latest = service.ReadJournal(SiteId, null).LatestSequence;
        var requested = latest + 100;

        var result = service.ReadJournal(SiteId, $"{service.JournalEpoch:D}:{requested}");
        Assert.True(result.HasGap);
        Assert.True(result.CursorAccepted);
        Assert.Equal(requested, result.RequestedSequence);
        Assert.NotEmpty(result.Events);
        Assert.Equal(result.FirstRetainedSequence, result.Events[0].Sequence);
        Assert.All(result.Events, envelope => Assert.Equal(command.CommandId, envelope.Payload.CommandId));
    }

    [Fact]
    public void ReadJournalSinceDetectsCursorAheadOfEmptyJournal()
    {
        var service = Service();
        var result = service.ReadJournalSince(SiteId, 5);

        Assert.True(result.HasGap);
        Assert.True(result.CursorAccepted);
        Assert.Empty(result.Events);
        Assert.Equal(5, result.RequestedSequence);
        Assert.Equal(0, result.LatestSequence);
        Assert.Equal(1, result.FirstRetainedSequence);
    }

    [Fact]
    public void ReadJournalSinceDetectsLiveRetentionGap()
    {
        var service = Service(new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxJournalEventsPerSite = 2
        });
        Submit(service, "equipment-0", "key-1");
        Submit(service, "equipment-1", "key-2");
        Submit(service, "equipment-2", "key-3");

        var result = service.ReadJournalSince(SiteId, 0);
        Assert.True(result.HasGap);
        Assert.True(result.CursorAccepted);
        Assert.Equal(new long[] { 2, 3 }, result.Events.Select(envelope => envelope.Sequence).ToArray());

        var caughtUp = service.ReadJournalSince(SiteId, result.LatestSequence);
        Assert.False(caughtUp.HasGap);
        Assert.Empty(caughtUp.Events);
    }

    [Fact]
    public void ReadJournalSinceDetectsForeignEpoch()
    {
        var service = Service();
        Submit(service, "equipment-0", "key-1");

        var result = service.ReadJournalSince(SiteId, 0, cursorEpoch: Guid.NewGuid());
        Assert.True(result.HasGap);
        Assert.False(result.CursorAccepted);
        Assert.NotEmpty(result.Events);
    }

    [Fact]
    public void JournalReadsFilterSingleFabEventsAndExcludeForeignIdentity()
    {
        var service = Service();
        var foreignFabId = Guid.NewGuid().ToString("D");
        Submit(service, "equipment-0", "key-1");

        var all = service.ReadJournal(SiteId, null);
        Assert.NotEmpty(all.Events);
        Assert.All(all.Events, envelope => Assert.Equal(FabId, envelope.Payload.FabId));

        Assert.Empty(service.ReadJournal(SiteId, null, foreignFabId).Events);
        Assert.Empty(service.ReadJournalSince(SiteId, 0, foreignFabId).Events);

        var replay = service.ReadJournal(SiteId, null, FabId);
        Assert.NotEmpty(replay.Events);
        Assert.All(replay.Events, envelope => Assert.Equal(FabId, envelope.Payload.FabId));
        var live = service.ReadJournalSince(SiteId, 0, FabId);
        Assert.NotEmpty(live.Events);
        Assert.All(live.Events, envelope => Assert.Equal(FabId, envelope.Payload.FabId));
    }

    private static EquipmentCommandService Service(EquipmentCommandOptions? options = null) =>
        new(new SiteDirectory(), TimeProvider.System, options);

    private static EquipmentCommandStatus Submit(EquipmentCommandService service, string equipmentId, string key, string? fabId = null)
    {
        var result = service.Submit(SiteId, new EquipmentCommandRequest(fabId ?? FabId, equipmentId, "START"), "local-developer", key);
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, result.Status);
        return result.Command!;
    }
}
