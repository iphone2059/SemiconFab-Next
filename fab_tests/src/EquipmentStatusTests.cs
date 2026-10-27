using Fab.App;
using Fab.Site;
using Xunit;

namespace Fab.Tests;

public sealed class EquipmentStatusTests
{
    [Fact]
    public void SequenceIsStableWithinBucketAndMonotonicPerFab()
    {
        var service = new EquipmentStatusService();
        var siteId = Guid.NewGuid();
        var fabId = Guid.NewGuid();
        var seed = new DateTimeOffset(2026, 10, 24, 2, 0, 0, TimeSpan.Zero);
        var t0 = DateTimeOffset.FromUnixTimeSeconds(seed.ToUnixTimeSeconds() / 8 * 8);

        var first = service.Get(siteId, fabId, t0);
        var sameBucket = service.Get(siteId, fabId, t0.AddSeconds(7));
        var nextBucket = service.Get(siteId, fabId, t0.AddSeconds(8));
        var lateFrame = service.Get(siteId, fabId, t0);

        Assert.Equal(121, first.Tools.Length);
        Assert.Equal(siteId.ToString("D"), first.SiteId);
        Assert.Equal(fabId.ToString("D"), first.FabId);
        Assert.Equal(first.Sequence, sameBucket.Sequence);
        Assert.Equal(nextBucket.Sequence, first.Sequence + 1);
        Assert.Equal(nextBucket.Sequence, lateFrame.Sequence);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(t0.ToUnixTimeSeconds() / 8 * 8).ToString("O"), first.GeneratedAt);
        Assert.All(first.Tools, tool => Assert.Contains(tool.State, new[] { "running", "idle", "down", "maint" }));
    }

    [Fact]
    public void SequenceIsIndependentPerFab()
    {
        var service = new EquipmentStatusService();
        var siteId = Guid.NewGuid();
        var fabA = Guid.NewGuid();
        var fabB = Guid.NewGuid();
        var t0 = new DateTimeOffset(2026, 10, 24, 3, 0, 0, TimeSpan.Zero);

        Assert.Equal(1, service.Get(siteId, fabA, t0).Sequence);
        Assert.Equal(1, service.Get(siteId, fabB, t0).Sequence);
        Assert.Equal(2, service.Get(siteId, fabA, t0.AddSeconds(8)).Sequence);
        Assert.Equal(1, service.Get(siteId, fabB, t0).Sequence);
        Assert.Equal(2, service.Get(siteId, fabB, t0.AddSeconds(8)).Sequence);
        Assert.Equal(2, service.Get(siteId, fabB, t0.AddSeconds(8)).Sequence);
    }

    [Fact]
    public void TelemetryStateValuesMatchEquipmentStatusForSameFabAndEquipment()
    {
        var directory = new SiteDirectory();
        var status = new EquipmentStatusService();
        var telemetry = new TelemetrySimulationService(directory, status);
        var siteId = SiteDirectory.DemoSiteId;
        var fab = SiteDirectory.CreateFab(2);
        var t0 = new DateTimeOffset(2026, 10, 24, 4, 0, 0, TimeSpan.Zero);

        var snapshot = status.Get(siteId, fab.Id, t0);
        var frame = telemetry.CreateFrame(siteId, fab.Id, 1, t0);

        Assert.Equal(fab.Id.ToString("D"), frame.Payload.FabId);
        Assert.Equal(16, frame.Payload.Samples.Length);
        for (var index = 0; index < frame.Payload.Samples.Length; index++)
        {
            var sample = frame.Payload.Samples[index];
            Assert.Equal($"equipment-{index}", sample.EntityId);
            Assert.Equal(ExpectedTelemetryState(snapshot.Tools[index].State), sample.Values.State);
            Assert.InRange(sample.Values.Utilization, 0d, 1d);
        }
    }

    private static int ExpectedTelemetryState(string toolState) => toolState switch
    {
        "running" => 0,
        "idle" => 1,
        "down" => 2,
        "maint" => 3,
        _ => throw new InvalidOperationException("Unexpected synthetic tool state: " + toolState)
    };
}
