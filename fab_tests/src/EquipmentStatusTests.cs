using Fab.App;
using Xunit;

namespace Fab.Tests;

public sealed class EquipmentStatusTests
{
    [Fact]
    public void SequenceIsStableWithinBucketAndMonotonicAcrossBuckets()
    {
        var service = new EquipmentStatusService();
        var siteId = Guid.NewGuid();
        var seed = new DateTimeOffset(2026, 10, 24, 2, 0, 0, TimeSpan.Zero);
        var t0 = DateTimeOffset.FromUnixTimeSeconds(seed.ToUnixTimeSeconds() / 8 * 8);

        var first = service.Get(siteId, t0);
        var sameBucket = service.Get(siteId, t0.AddSeconds(7));
        var nextBucket = service.Get(siteId, t0.AddSeconds(8));
        var lateFrame = service.Get(siteId, t0);

        Assert.Equal(121, first.Tools.Length);
        Assert.Equal(first.Sequence, sameBucket.Sequence);
        Assert.Equal(nextBucket.Sequence, first.Sequence + 1);
        Assert.Equal(nextBucket.Sequence, lateFrame.Sequence);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(t0.ToUnixTimeSeconds() / 8 * 8).ToString("O"), first.GeneratedAt);
        Assert.All(first.Tools, tool => Assert.Contains(tool.State, new[] { "running", "idle", "down", "maint" }));
    }

    [Fact]
    public void SequenceIsIndependentPerSite()
    {
        var service = new EquipmentStatusService();
        var t0 = new DateTimeOffset(2026, 10, 24, 3, 0, 0, TimeSpan.Zero);
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();

        Assert.Equal(1, service.Get(a, t0).Sequence);
        Assert.Equal(1, service.Get(b, t0).Sequence);
        Assert.Equal(2, service.Get(a, t0.AddSeconds(8)).Sequence);
        Assert.Equal(2, service.Get(b, t0.AddSeconds(8)).Sequence);
    }
}
