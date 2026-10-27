using System.Text.Json;
using Fab.Contracts;
using Fab.Simulation;
using Xunit;

namespace Fab.Tests;

public sealed class SimulationTests
{
    private const string A = "11111111-1111-4111-8111-111111111111";
    private const string B = "22222222-2222-4222-8222-222222222222";
    private static ScenarioDefinition Scenario() => new(1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "INDEPENDENT", "42", "1000", "0", [new(A, "FAB-01", 12, "20"), new(B, "FAB-02", 4, "30")]);

    [Fact]
    public void EqualInputsHaveIdenticalSemanticEventsAndHash()
    {
        var engine = new FabSimulation();
        var first = engine.Execute(Scenario(), A);
        Assert.Equal(JsonSerializer.Serialize(first), JsonSerializer.Serialize(engine.Execute(Scenario(), A)));
        Assert.Equal(36, first.Events.Length);
        Assert.Equal(Enumerable.Range(1, 36).Select(x => x.ToString()), first.Events.Select(x => x.Sequence));
        Assert.Equal(Enumerable.Range(1, 12).Select(x => x.ToString()), first.Events.Where(x => x.Kind == "OperationCompleted").Select(x => x.EntityId));
        Assert.Equal("1000", first.SimulationTimeUs);
    }

    [Fact]
    public void ChangingAnotherFabAndMemberOrderCannotChangeSelectedFab()
    {
        var scenario = Scenario();
        var modified = scenario with { Fabs = [scenario.Fabs[1] with { LotCount = 100, ProcessTimeUs = "99" }, scenario.Fabs[0]] };
        Assert.Equal(JsonSerializer.Serialize(new FabSimulation().Execute(scenario, A)), JsonSerializer.Serialize(new FabSimulation().Execute(modified, A)));
    }

    [Fact]
    public void CheckpointRoundtripAtEveryBoundaryPreservesFinalHash()
    {
        var engine = new FabSimulation();
        var expected = engine.Execute(Scenario(), A);
        var session = engine.Start(Scenario(), A);
        do
        {
            var json = JsonSerializer.Serialize(session.CreateCheckpoint());
            var checkpoint = JsonSerializer.Deserialize<SimulationCheckpoint>(json)!;
            var resumed = engine.Resume(checkpoint);
            Assert.Equal(JsonSerializer.Serialize(expected), JsonSerializer.Serialize(resumed.RunToCompletion()));
        } while (session.StepOneEvent());
    }

    [Fact]
    public void QueueOrdersByTimeThenPriorityThenEnqueueSequence()
    {
        var queue = new StableEventQueue();
        queue.Enqueue(new(10, 1, 1, 1, "late"));
        queue.Enqueue(new(0, 2, 2, 2, "second"));
        queue.Enqueue(new(0, 1, 4, 4, "first"));
        queue.Enqueue(new(0, 2, 3, 3, "third"));
        Assert.Equal(new long[] { 4, 2, 3, 1 }, Enumerable.Range(0, 4).Select(_ => queue.Dequeue().EnqueueSequence));
    }

    [Theory]
    [InlineData("0", "3", "-1", "1", "1", "1")]
    [InlineData("0", "3", "3", "1", "1", "0")]
    [InlineData("-1", "3", "0", "1", "1", "0")]
    [InlineData("18446744073709551616", "3", "0", "1", "1", "0")]
    [InlineData("0", "9223372036854775808", "0", "1", "1", "0")]
    [InlineData("0", "3", "0", "0", "1", "0")]
    [InlineData("0", "3", "0", "9223372036854775807", "2", "0")]
    [InlineData("0", "3", "0", "1", "10001", "0")]
    [InlineData("0", "3", "0", "1", "0", "0")]
    [InlineData(" 0", "3", "0", "1", "1", "0")]
    [InlineData("+0", "3", "0", "1", "1", "0")]
    [InlineData("00", "3", "0", "1", "1", "0")]
    [InlineData("042", "3", "0", "1", "1", "0")]
    [InlineData("0", "03", "0", "1", "1", "0")]
    [InlineData("0", "3", "00", "1", "1", "0")]
    [InlineData("0", "3", "0", "01", "1", "0")]
    public void RejectsInvalidNumbers(string seed, string duration, string warmup, string process, string lots, string unused)
    {
        _ = unused;
        var s = Scenario() with { MasterSeed = seed, DurationUs = duration, WarmupUs = warmup, Fabs = [new(A, "FAB-01", int.Parse(lots), process)] };
        Assert.ThrowsAny<ArgumentException>(() => new FabSimulation().Execute(s, A));
    }

    [Fact]
    public void RejectsInvalidMembershipModesAndIds()
    {
        var engine = new FabSimulation();
        var s = Scenario();
        foreach (var invalid in new[] { s with { Fabs = [] }, s with { Fabs = [s.Fabs[0], s.Fabs[0]] }, s with { SiteId = Guid.Empty.ToString() }, s with { Mode = "SHARED_CAPACITY" }, s with { ContractVersion = 2 }, s with { Fabs = [s.Fabs[0] with { FabId = "bad" }] }, s with { Fabs = [s.Fabs[0], s.Fabs[1] with { Code = s.Fabs[0].Code }] }, s with { Fabs = Enumerable.Range(1, 33).Select(i => new FabScenario(new Guid(i, 0, 0, new byte[8]).ToString(), "F" + i, 1, "1")).ToArray() } })
            Assert.ThrowsAny<ArgumentException>(() => engine.Execute(invalid, A));
        Assert.ThrowsAny<ArgumentException>(() => engine.Execute(s, "33333333-3333-4333-8333-333333333333"));
    }

    [Fact]
    public void WarmupAndDurationUseHalfOpenWindowAndBusyOverlap()
    {
        var s = Scenario() with { DurationUs = "3", WarmupUs = "1", Fabs = [new(A, "FAB-01", 4, "1")] };
        var result = new FabSimulation().Execute(s, A);
        Assert.Equal("2", result.CompletedLots);
        Assert.Equal("2", result.BusyTimeUs);
        Assert.DoesNotContain(result.Events, e => e.SimulationTimeUs == "3");
        Assert.Equal("3", result.SimulationTimeUs);
    }

    [Fact]
    public void CancellationStopsAtBoundaryWithoutConsumingAnEvent()
    {
        using var cancellation = new CancellationTokenSource();
        var session = new FabSimulation().Start(Scenario(), A);
        var before = JsonSerializer.Serialize(session.CreateCheckpoint());
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => session.StepOneEvent(cancellation.Token));
        Assert.Equal(before, JsonSerializer.Serialize(session.CreateCheckpoint()));
        Assert.Throws<OperationCanceledException>(() => new FabSimulation().Execute(Scenario(), A, cancellation.Token));
    }

    [Fact]
    public void RejectsTamperedAndIncompatibleCheckpoints()
    {
        var engine = new FabSimulation();
        var checkpoint = engine.Start(Scenario(), A).CreateCheckpoint();
        Assert.ThrowsAny<ArgumentException>(() => engine.Resume(checkpoint with { SchemaVersion = 99 }));
        Assert.ThrowsAny<ArgumentException>(() => engine.Resume(checkpoint with { StateJson = "{}" }));
    }

    [Fact]
    public void QueueRejectsReusedEnqueueSequence()
    {
        var queue = new StableEventQueue();
        queue.Enqueue(new(0, 0, 1, 1, "first"));
        queue.Dequeue();
        Assert.ThrowsAny<ArgumentException>(() => queue.Enqueue(new(1, 0, 1, 2, "reused")));
    }

    [Fact]
    public void SplitMix64MatchesFrozenUnsignedVectors()
    {
        var rng = new SplitMix64(0);
        Assert.Equal(0x13489A24519FD7B9UL, SplitMix64.Derive(42, A));
        Assert.Equal(0xE220A8397B1DCDAFUL, rng.Next());
        Assert.Equal(0x6E789E6AA1B965F4UL, rng.Next());
        var resumed = new SplitMix64(rng.State);
        Assert.Equal(rng.Next(), resumed.Next());
    }

    [Fact]
    public void MaximumWorkloadAndUInt64SeedRemainBounded()
    {
        var scenario = Scenario() with { MasterSeed = ulong.MaxValue.ToString(), DurationUs = long.MaxValue.ToString(), Fabs = [new(A, "FAB-01", 10000, "1")] };
        var result = new FabSimulation().Execute(scenario, A);
        Assert.Equal("10000", result.CompletedLots);
        Assert.Equal("10000", result.BusyTimeUs);
        Assert.Equal(30000, result.Events.Length);
    }

    [Fact]
    public void SeedChangesServiceTimesWithoutChangingFifoOrder()
    {
        var engine = new FabSimulation();
        var first = engine.Execute(Scenario(), A);
        var second = engine.Execute(Scenario() with { MasterSeed = "123456789" }, A);
        Assert.NotEqual(first.TraceHash, second.TraceHash);
        Assert.Equal(first.Events.Select(e => e.EntityId), second.Events.Select(e => e.EntityId));
    }

    [Fact]
    public void FinishedCheckpointWithCutoffRestoresAndCallerArrayCannotMutateSession()
    {
        var engine = new FabSimulation();
        var scenario = Scenario() with { DurationUs = "1" };
        var session = engine.Start(scenario, A);
        scenario.Fabs[0] = scenario.Fabs[0] with { LotCount = 9000 };
        var result = session.RunToCompletion();
        Assert.Equal("12", result.TotalLots);
        Assert.Equal(JsonSerializer.Serialize(result), JsonSerializer.Serialize(engine.Resume(session.CreateCheckpoint()).RunToCompletion()));
    }

    [Fact]
    public void RecomputedChecksumCannotHideInvalidRngOrEventWatermarks()
    {
        var engine = new FabSimulation();
        var checkpoint = engine.Start(Scenario(), A).CreateCheckpoint();
        var root = System.Text.Json.Nodes.JsonNode.Parse(checkpoint.StateJson)!;
        root["RngState"] = 0UL;
        var modified = root.ToJsonString();
        var checksum = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(modified))).ToLowerInvariant();
        Assert.ThrowsAny<ArgumentException>(() => engine.Resume(checkpoint with { StateJson = modified, Checksum = checksum }));
    }

    // Digests frozen from the record-class baseline (fab_tests 153/153 green) before the
    // value-type/allocation refactor: event JSON, stats and checkpoint bytes must not move.
    [Fact]
    public void FrozenSimulationDigestsMatchPreChangeBaseline()
    {
        var engine = new FabSimulation();
        var result = engine.Execute(Scenario(), A);
        Assert.Equal("24c25351333588496775fb264f9fd2f973c1cdc2ad2e6bf81d1edd23ee6f1cb2", result.TraceHash);
        Assert.Equal("12", result.CompletedLots);
        Assert.Equal("12", result.TotalLots);
        Assert.Equal("1000", result.SimulationTimeUs);
        Assert.Equal("252", result.BusyTimeUs);
        Assert.Equal(36, result.Events.Length);

        var session = engine.Start(Scenario(), A);
        var start = session.CreateCheckpoint();
        Assert.Equal("b84499972d471543c2f6ae334c530495965ef3ccc35b0c92c6baed99c5fec647", start.Checksum);
        session.StepOneEvent();
        var afterOne = session.CreateCheckpoint();
        Assert.Equal("0472573da77977b8bfb3d9a11aa5b4beef62ab9cf811f29332c862beeeb4ed2a", afterOne.Checksum);
        Assert.Equal(1818, afterOne.StateJson.Length);
        session.StepOneEvent();
        var afterTwo = session.CreateCheckpoint();
        Assert.Equal("7c218dc16f01190a9a67d0291a19777a751c076c256ebdf368c869c6e39e2d99", afterTwo.Checksum);
        Assert.Equal(1868, afterTwo.StateJson.Length);
    }

    [Fact]
    public void ScheduledEventIsValueTypeWithValueEqualityAndCausalKey()
    {
        Assert.True(typeof(ScheduledEvent).IsValueType);
        var original = new ScheduledEvent(10, 2, 3, 4, "LotReleased");
        var copy = original with { };
        Assert.Equal(original, copy);
        Assert.True(original == copy);
        var queue = new StableEventQueue();
        queue.Enqueue(original);
        Assert.Equal(original, queue.Peek());
        Assert.Equal(original, queue.Dequeue());
        Assert.Equal(0, queue.Count);
    }

    [Fact]
    public void QueueAcceptsUniqueSequencesInAnyEnqueueOrderAndRejectsReuse()
    {
        var queue = new StableEventQueue();
        queue.Enqueue(new(30, 0, 3, 1, "third"));
        queue.Enqueue(new(0, 0, 1, 2, "first"));
        queue.Enqueue(new(20, 0, 2, 3, "second"));
        Assert.ThrowsAny<ArgumentException>(() => queue.Enqueue(new(40, 0, 2, 4, "reused")));
        Assert.Equal(new long[] { 1, 2, 3 }, queue.Snapshot().Select(e => e.EnqueueSequence));
        Assert.Equal(new long[] { 1, 2, 3 }, Enumerable.Range(0, 3).Select(_ => queue.Dequeue().EnqueueSequence));
    }

    [Theory]
    [InlineData(-1, 0, 1)]
    [InlineData(0, -1, 1)]
    [InlineData(0, 0, 0)]
    [InlineData(0, 0, -5)]
    public void QueueRejectsInvalidOrderingKeys(long timeUs, int priority, long sequence)
    {
        var queue = new StableEventQueue();
        Assert.ThrowsAny<ArgumentException>(() => queue.Enqueue(new ScheduledEvent(timeUs, priority, sequence, 1, "invalid")));
        Assert.Equal(0, queue.Count);
        Assert.Empty(queue.Snapshot());
    }
}
