using Fab.Contracts;
using System.Diagnostics;
using Fab.Orchestration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Fab.Tests;

public sealed class LocalOrchestrationTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "fab-orchestration-" + Guid.NewGuid());
    private static readonly string SiteId = "10000000-0000-0000-0000-000000000001";
    private static readonly string FabId = "20000000-0000-0000-0000-000000000001";
    private static CreateRunRequest Request() => new(new(1, SiteId, "INDEPENDENT", "42", "100000", "0", [new(FabId, "FAB-01", 3, "100")]));

    [Fact]
    public void Same_idempotency_scope_returns_original_after_restart()
    {
        var first = new FileRunStore(directory).Submit(Request(), "operator", "retry-key");
        var restarted = new FileRunStore(directory);
        Assert.Equal(first.RunId, restarted.Submit(Request(), "operator", "retry-key").RunId);
        Assert.Equal(first.RunId, Assert.Single(restarted.List()).RunId);
        Assert.Equal("QUEUED", restarted.Get(Guid.Parse(first.RunId))!.Status);
    }

    [Fact]
    public void Changed_request_in_same_scope_conflicts_but_other_principal_is_independent()
    {
        var store = new FileRunStore(directory);
        var original = store.Submit(Request(), "operator", "key");
        var changed = Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } };
        Assert.Throws<IdempotencyConflictException>(() => store.Submit(changed, "operator", "key"));
        Assert.NotEqual(original.RunId, store.Submit(changed, "other", "key").RunId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Idempotent_create_replays_original_response_after_completion(bool missingIndex)
    {
        var store = new FileRunStore(directory);
        var original = store.Submit(Request(), "operator", "key");
        store.Complete(store.TryClaim("worker")!, Result());
        Assert.Equal("COMPLETED", store.Get(Guid.Parse(original.RunId))!.Status);
        if (missingIndex) File.Delete(Path.Combine(directory, "idempotency-index.json"));
        var replay = new FileRunStore(directory).Submit(Request(), "operator", "key");
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(original), System.Text.Json.JsonSerializer.Serialize(replay));
    }

    [Fact]
    public async Task Two_workers_cannot_claim_same_active_execution()
    {
        new FileRunStore(directory).Submit(Request(), "operator", "key");
        var workers = new[] { new FileRunStore(directory), new FileRunStore(directory) };
        var leases = await Task.WhenAll(workers.Select((store, i) => Task.Run(() => store.TryClaim("worker-" + i))));
        Assert.Single(leases, lease => lease is not null);
    }

    [Fact]
    public void Expired_lease_is_reclaimed_and_old_owner_cannot_publish_or_renew()
    {
        var clock = new ManualClock();
        var store = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10));
        var run = store.Submit(Request(), "operator", "key");
        var old = store.TryClaim("old")!;
        clock.Advance(TimeSpan.FromSeconds(11));
        Assert.False(store.Renew(old));
        Assert.Throws<LeaseLostException>(() => store.Complete(old, Result()));
        var current = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10)).TryClaim("new")!;
        Assert.True(current.Epoch > old.Epoch);
        Assert.Throws<LeaseLostException>(() => store.Complete(old, Result()));
        Assert.Throws<LeaseLostException>(() => store.Fail(old, "stale failure"));
        store.Complete(current, Result());
        Assert.Equal("COMPLETED", store.Get(Guid.Parse(run.RunId))!.Status);
    }

    [Fact]
    public void Run_completes_only_after_all_results_are_persisted()
    {
        var store = new FileRunStore(directory);
        var second = "20000000-0000-0000-0000-000000000002";
        var request = Request() with { Scenario = Request().Scenario with { Fabs = [new(FabId, "FAB-01", 3, "100"), new(second, "FAB-02", 3, "100")] } };
        var run = store.Submit(request, "operator", "key");
        var id = Guid.Parse(run.RunId);
        store.Complete(store.TryClaim("worker")!, Result());
        Assert.Equal("RUNNING", store.Get(id)!.Status);
        Assert.Null(store.GetResults(id));
        var last = store.TryClaim("worker")!;
        store.Complete(last, Result() with { FabId = second });
        var restarted = new FileRunStore(directory);
        Assert.Equal("COMPLETED", restarted.Get(id)!.Status);
        Assert.Equal(2, restarted.GetResults(id)!.Fabs.Length);
    }

    [Fact]
    public void Wrong_fab_result_cannot_complete_execution()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var lease = store.TryClaim("worker")!;
        Assert.Throws<ArgumentException>(() => store.Complete(lease, Result() with { FabId = Guid.NewGuid().ToString() }));
        Assert.NotEqual("COMPLETED", store.Get(Guid.Parse(run.RunId))!.Status);
    }

    [Theory]
    [InlineData("complete")]
    [InlineData("renew")]
    [InlineData("fail")]
    public void Lease_expiring_at_metadata_publication_cannot_commit(string operation)
    {
        var clock = new ScriptedClock();
        var store = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10));
        var run = store.Submit(Request(), "operator", "key");
        var lease = store.TryClaim("worker")!;
        clock.ReadsBeforeExpiry = operation == "fail" ? 1 : 2;
        if (operation == "renew") Assert.False(store.Renew(lease));
        else if (operation == "complete") Assert.Throws<LeaseLostException>(() => store.Complete(lease, Result()));
        else Assert.Throws<LeaseLostException>(() => store.Fail(lease, "failure"));
        Assert.Equal("RUNNING", store.Get(Guid.Parse(run.RunId))!.Status);
        Assert.NotNull(store.TryClaim("replacement"));
    }

    [Theory]
    [InlineData("SHARED_CAPACITY")]
    [InlineData("unknown")]
    [InlineData("")]
    public void Unsupported_modes_are_rejected(string mode)
    {
        var request = Request() with { Scenario = Request().Scenario with { Mode = mode } };
        Assert.ThrowsAny<ArgumentException>(() => new FileRunStore(directory).Submit(request, "operator", "key"));
    }

    [Fact]
    public void Empty_and_invalid_members_are_rejected()
    {
        var store = new FileRunStore(directory);
        Assert.ThrowsAny<ArgumentException>(() => store.Submit(Request() with { Scenario = Request().Scenario with { Fabs = [] } }, "operator", "key"));
        Assert.ThrowsAny<ArgumentException>(() => store.Submit(Request() with { Scenario = Request().Scenario with { Fabs = [new("invalid", "FAB-01", 1, "1")] } }, "operator", "key"));
    }

    [Fact]
    public async Task Worker_failure_is_visible_and_does_not_report_success()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        using var worker = new SimulationWorker(store, new ThrowingEngine(), new EnvironmentStub("Development"), NullLogger<SimulationWorker>.Instance);
        Assert.True(await worker.ProcessNextAsync(CancellationToken.None));
        var summary = store.Get(Guid.Parse(run.RunId))!;
        Assert.Equal("FAILED", summary.Status);
        Assert.Contains("synthetic failure", Assert.Single(summary.Executions).Error);
        Assert.Null(store.GetResults(Guid.Parse(run.RunId)));
    }

    [Fact]
    public async Task Production_worker_fails_closed()
    {
        using var worker = new SimulationWorker(new FileRunStore(directory), new ThrowingEngine(), new EnvironmentStub("Production"), NullLogger<SimulationWorker>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() => worker.StartAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Separate_processes_observe_same_run_and_only_one_claims()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var claims = await Task.WhenAll(RunProcess("claim"), RunProcess("claim"));
        Assert.Single(claims, value => value == run.RunId);
        Assert.Single(claims, value => value == "none");
        Assert.Equal("RUNNING", store.Get(Guid.Parse(run.RunId))!.Status);
    }

    [Fact]
    public async Task Real_engine_accepts_uppercase_uuid_members()
    {
        var fabId = "abcdef12-0000-0000-0000-000000000001".ToUpperInvariant();
        var store = new FileRunStore(directory);
        var request = Request() with { Scenario = Request().Scenario with { Fabs = [new(fabId, "FAB-01", 3, "100")] } };
        var run = store.Submit(request, "operator", "key");
        using var worker = new SimulationWorker(store, new LocalSimulationExecution(), new EnvironmentStub("Development"), NullLogger<SimulationWorker>.Instance);
        Assert.True(await worker.ProcessNextAsync(CancellationToken.None));
        Assert.Equal("COMPLETED", store.Get(Guid.Parse(run.RunId))!.Status);
        Assert.Single(store.GetResults(Guid.Parse(run.RunId))!.Fabs);
    }

    [Fact]
    public async Task Engine_holds_no_store_lock_and_heartbeat_keeps_lease_alive()
    {
        var store = new FileRunStore(directory, leaseDuration: TimeSpan.FromMilliseconds(600));
        var run = store.Submit(Request(), "operator", "key");
        var engine = new BlockingEngine();
        using var worker = new SimulationWorker(store, engine, new EnvironmentStub("Development"), NullLogger<SimulationWorker>.Instance);
        var processing = worker.ProcessNextAsync(CancellationToken.None);
        await engine.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await Task.Delay(1500);
            Assert.Equal("RUNNING", store.Get(Guid.Parse(run.RunId))!.Status);
            Assert.Null(new FileRunStore(directory).TryClaim("competitor"));
        }
        finally { engine.Release.SetResult(); }
        Assert.True(await processing.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal("COMPLETED", store.Get(Guid.Parse(run.RunId))!.Status);
    }

    [Fact]
    public void Missing_index_is_recovered_from_run_and_corrupt_result_cannot_report_success()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        File.Delete(Path.Combine(directory, "idempotency-index.json"));
        Assert.Equal(run.RunId, new FileRunStore(directory).Submit(Request(), "operator", "key").RunId);
        store.Complete(store.TryClaim("worker")!, Result());
        File.WriteAllText(Assert.Single(Directory.GetFiles(Path.Combine(directory, "results"), "*.json")), "{}");
        Assert.Throws<InvalidDataException>(() => store.Get(Guid.Parse(run.RunId)));
        Assert.Throws<InvalidDataException>(() => store.GetResults(Guid.Parse(run.RunId)));
    }

    private async Task<string> RunProcess(string operation)
    {
        var start = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add(typeof(LocalOrchestrationTests).Assembly.Location);
        start.ArgumentList.Add(operation);
        start.ArgumentList.Add(directory);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
        Assert.True(process.ExitCode == 0, await error);
        return (await output).Trim();
    }

    public static int Main(string[] args)
    {
        if (args is ["claim", var path])
        {
            Console.WriteLine(new FileRunStore(path).TryClaim("process-" + Environment.ProcessId)?.RunId.ToString("D") ?? "none");
            return 0;
        }
        return 1;
    }

    private static FabSimulationResult Result() => new(FabId, "3", "3", "300", "300", "trace", []);
    public void Dispose() { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    private sealed class ManualClock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.Parse("2026-10-23T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
    private sealed class ScriptedClock : TimeProvider
    {
        public int ReadsBeforeExpiry { get; set; } = int.MaxValue;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.Parse("2026-10-23T00:00:00Z").AddSeconds(ReadsBeforeExpiry-- > 0 ? 0 : 11);
    }
    private sealed class ThrowingEngine : ISimulationExecutionPort
    {
        public FabSimulationResult Execute(ScenarioDefinition scenario, string fabId, CancellationToken token) => throw new InvalidOperationException("synthetic failure");
    }
    private sealed class BlockingEngine : ISimulationExecutionPort
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public FabSimulationResult Execute(ScenarioDefinition scenario, string fabId, CancellationToken token)
        {
            Entered.SetResult();
            Release.Task.Wait(token);
            return Result();
        }
    }
    private sealed class EnvironmentStub(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = ".";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
