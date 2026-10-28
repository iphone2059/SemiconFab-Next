using Fab.Contracts;
using System.Diagnostics;
using System.Text.Json.Nodes;
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
        if (missingIndex) Directory.Delete(Path.Combine(directory, "idempotency"), recursive: true);
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
    public void Run_completes_only_after_its_single_fab_result_is_persisted()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var id = Guid.Parse(run.RunId);
        Assert.Equal("QUEUED", store.Get(id)!.Status);
        Assert.Null(store.GetResults(id));
        var lease = store.TryClaim("worker")!;
        Assert.Equal("RUNNING", store.Get(id)!.Status);
        Assert.Null(store.GetResults(id));
        store.Complete(lease, Result());
        var restarted = new FileRunStore(directory);
        Assert.Equal("COMPLETED", restarted.Get(id)!.Status);
        Assert.Equal("COMPLETED", Assert.Single(restarted.Get(id)!.Executions).Status);
        Assert.Equal(FabId, Assert.Single(restarted.GetResults(id)!.Fabs).FabId);
        Assert.Null(restarted.TryClaim("idle"));
    }

    [Fact]
    public void Wrong_fab_result_cannot_complete_execution()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var lease = store.TryClaim("worker")!;
        Assert.Throws<ArgumentException>(() => store.Complete(lease, Result() with { FabId = Guid.NewGuid().ToString() }));
        var id = Guid.Parse(run.RunId);
        Assert.Equal("RUNNING", store.Get(id)!.Status);
        Assert.Null(store.GetResults(id));
        store.Complete(lease, Result());
        Assert.Equal("COMPLETED", store.Get(id)!.Status);
        Assert.Equal(FabId, Assert.Single(store.GetResults(id)!.Fabs).FabId);
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
        Directory.Delete(Path.Combine(directory, "idempotency"), recursive: true);
        Assert.Equal(run.RunId, new FileRunStore(directory).Submit(Request(), "operator", "key").RunId);
        store.Complete(store.TryClaim("worker")!, Result());
        File.WriteAllText(Assert.Single(Directory.GetFiles(Path.Combine(directory, "results"), "*.json")), "{}");
        Assert.Throws<InvalidDataException>(() => store.Get(Guid.Parse(run.RunId)));
        Assert.Throws<InvalidDataException>(() => store.GetResults(Guid.Parse(run.RunId)));
    }

    [Fact]
    public void Pending_index_survives_restart_and_claim_works()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var indexPath = Path.Combine(directory, "pending-index.json");
        Assert.True(File.Exists(indexPath));
        Assert.Contains(run.RunId, File.ReadAllText(indexPath));
        var lease = new FileRunStore(directory).TryClaim("worker");
        Assert.NotNull(lease);
        Assert.Equal(run.RunId, lease.RunId.ToString("D"));
    }

    [Fact]
    public void Deleted_pending_index_is_rebuilt_from_runs()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var indexPath = Path.Combine(directory, "pending-index.json");
        File.Delete(indexPath);
        var lease = new FileRunStore(directory).TryClaim("worker");
        Assert.Equal(run.RunId, lease!.RunId.ToString("D"));
        Assert.True(File.Exists(indexPath));
    }

    [Fact]
    public void Corrupt_pending_index_is_rebuilt_from_runs()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        File.WriteAllText(Path.Combine(directory, "pending-index.json"), "{not valid json");
        var lease = new FileRunStore(directory).TryClaim("worker");
        Assert.Equal(run.RunId, lease!.RunId.ToString("D"));
    }

    [Fact]
    public void Stale_pending_index_is_rebuilt_from_runs()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        const string staleIndex = """{"version":1,"rebuiltAtUtc":"2000-01-01T00:00:00+00:00","entries":[]}""";
        File.WriteAllText(Path.Combine(directory, "pending-index.json"), staleIndex);
        var lease = new FileRunStore(directory).TryClaim("worker");
        Assert.Equal(run.RunId, lease!.RunId.ToString("D"));
    }

    [Fact]
    public void Idle_claim_does_not_parse_unrelated_completed_runs()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        store.Complete(store.TryClaim("worker")!, Result());
        var completedRunPath = Path.Combine(directory, "runs", Guid.Parse(run.RunId).ToString("N") + ".json");
        File.WriteAllText(completedRunPath, "{not valid json");
        // The completed execution is gone from the pending index, so an idle claim must not read its Run file.
        Assert.Null(new FileRunStore(directory).TryClaim("idle"));
    }

    [Fact]
    public void Claim_keeps_created_at_order_and_skips_completed_executions()
    {
        var clock = new ManualClock();
        var store = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10));
        var first = store.Submit(Request(), "operator", "first");
        clock.Advance(TimeSpan.FromSeconds(1));
        var second = store.Submit(Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } }, "operator", "second");
        var oldest = store.TryClaim("worker")!;
        Assert.Equal(first.RunId, oldest.RunId.ToString("D"));
        store.Complete(oldest, Result());
        Assert.Equal(second.RunId, store.TryClaim("worker")!.RunId.ToString("D"));
    }

    [Fact]
    public void Submit_repairs_deleted_pending_index_without_losing_queued_runs()
    {
        var clock = new ManualClock();
        var store = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10));
        var first = store.Submit(Request(), "operator", "first");
        File.Delete(Path.Combine(directory, "pending-index.json"));
        clock.Advance(TimeSpan.FromSeconds(1));
        var second = store.Submit(Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } }, "operator", "second");
        Assert.Equal(first.RunId, store.TryClaim("worker")!.RunId.ToString("D"));
        Assert.Equal(second.RunId, store.TryClaim("worker")!.RunId.ToString("D"));
    }

    [Fact]
    public void Submit_from_one_instance_is_visible_to_another_under_the_lock()
    {
        var submitter = new FileRunStore(directory);
        var claimant = new FileRunStore(directory);
        var run = submitter.Submit(Request(), "operator", "key");
        var lease = claimant.TryClaim("worker");
        Assert.Equal(run.RunId, lease!.RunId.ToString("D"));
        Assert.Null(submitter.TryClaim("competitor"));
    }

    [Fact]
    public void Renewal_refreshes_pending_index_and_protects_the_lease()
    {
        var clock = new ManualClock();
        var store = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10));
        store.Submit(Request(), "operator", "key");
        var lease = store.TryClaim("worker")!;
        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.True(store.Renew(lease));
        clock.Advance(TimeSpan.FromSeconds(6));
        Assert.Null(new FileRunStore(directory, clock, TimeSpan.FromSeconds(10)).TryClaim("competitor"));
        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.NotNull(new FileRunStore(directory, clock, TimeSpan.FromSeconds(10)).TryClaim("replacement"));
    }

    [Fact]
    public void Expired_lease_is_reclaimed_by_a_restarted_instance_through_the_index()
    {
        var clock = new ManualClock();
        var store = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10));
        var run = store.Submit(Request(), "operator", "key");
        var first = store.TryClaim("first")!;
        clock.Advance(TimeSpan.FromSeconds(11));
        var second = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10)).TryClaim("second");
        Assert.Equal(run.RunId, second!.RunId.ToString("D"));
        Assert.True(second.Epoch > first.Epoch);
        Assert.Throws<LeaseLostException>(() => store.Complete(first, Result()));
        new FileRunStore(directory, clock, TimeSpan.FromSeconds(10)).Complete(second, Result());
        Assert.Equal("COMPLETED", store.Get(Guid.Parse(run.RunId))!.Status);
    }

    [Fact]
    public void Completion_removes_the_execution_from_the_pending_index()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        store.Complete(store.TryClaim("worker")!, Result());
        Assert.DoesNotContain(run.RunId, File.ReadAllText(Path.Combine(directory, "pending-index.json")));
        Assert.Null(store.TryClaim("idle"));
    }

    [Fact]
    public async Task Concurrent_instances_claim_each_execution_exactly_once()
    {
        var clock = new ManualClock();
        var submitter = new FileRunStore(directory, clock, TimeSpan.FromSeconds(10));
        submitter.Submit(Request(), "operator", "first");
        submitter.Submit(Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } }, "operator", "second");
        var stores = new[] { new FileRunStore(directory, clock, TimeSpan.FromSeconds(10)), new FileRunStore(directory, clock, TimeSpan.FromSeconds(10)) };
        var attempts = stores
            .SelectMany((store, storeIndex) => Enumerable.Range(0, 3).Select(attempt => Task.Run(() => store.TryClaim($"worker-{storeIndex}-{attempt}"))))
            .ToArray();
        var leases = (await Task.WhenAll(attempts)).OfType<ExecutionLease>().ToArray();
        Assert.Equal(2, leases.Length);
        Assert.Equal(2, leases.Select(lease => (lease.RunId, lease.FabId)).Distinct().Count());
    }

    [Fact]
    public async Task WaitForWorkAsync_wakes_on_submit_and_times_out()
    {
        var store = new FileRunStore(directory);
        var timer = Stopwatch.StartNew();
        await store.WaitForWorkAsync(TimeSpan.FromMilliseconds(150), CancellationToken.None);
        Assert.InRange(timer.Elapsed, TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
        var waiting = store.WaitForWorkAsync(TimeSpan.FromSeconds(10), CancellationToken.None);
        await Task.Delay(100);
        store.Submit(Request(), "operator", "key");
        await waiting.WaitAsync(TimeSpan.FromSeconds(5));
        // A new Run leaves one coalesced pending wakeup, so the next wait completes without blocking.
        store.Submit(Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } }, "operator", "second");
        await store.WaitForWorkAsync(TimeSpan.FromSeconds(5), CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task WaitForWorkAsync_honours_cancellation()
    {
        var store = new FileRunStore(directory);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.WaitForWorkAsync(TimeSpan.FromSeconds(10), cancellation.Token));
    }

    [Fact]
    public async Task Batched_submits_leave_at_most_one_pending_wakeup()
    {
        var store = new FileRunStore(directory);
        for (var index = 0; index < 20; index += 1)
            store.Submit(Request(), "operator", "batch-" + index);

        // Simulate a worker that is busy claiming: it never waits while work exists, so every
        // Submit wakeup released during the batch piles up until the work drains.
        var emptyClaims = 0;
        while (true)
        {
            var lease = store.TryClaim("worker");
            if (lease is not null)
            {
                store.Complete(lease, Result());
                continue;
            }
            emptyClaims += 1;
            if (!await store.WaitForWorkAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None)) break;
            Assert.True(emptyClaims <= 2, $"expected coalesced wakeups, saw {emptyClaims} consecutive empty claims");
        }

        // Capacity-one notification: one stale wake may remain after the batch, never one per Submit.
        Assert.InRange(emptyClaims, 1, 2);
    }

    [Fact]
    public async Task Repeated_idempotent_submits_coalesce_into_one_wakeup()
    {
        var store = new FileRunStore(directory);
        for (var index = 0; index < 10; index += 1) store.Submit(Request(), "operator", "same-key");

        Assert.True(await store.WaitForWorkAsync(TimeSpan.FromSeconds(2), CancellationToken.None));
        Assert.False(await store.WaitForWorkAsync(TimeSpan.FromMilliseconds(100), CancellationToken.None));
    }

    [Fact]
    public void RecoverIndexes_restores_a_run_missing_from_the_pending_index()
    {
        var store = new FileRunStore(directory);
        store.Submit(Request(), "operator", "first");
        store.Complete(store.TryClaim("worker")!, Result());
        var pendingPath = Path.Combine(directory, "pending-index.json");
        var emptyIndex = File.ReadAllBytes(pendingPath);
        var second = store.Submit(Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } }, "operator", "second");
        // Simulate a crash between Save(run) and the pending-index write: the Run file exists, the index omits it.
        File.WriteAllBytes(pendingPath, emptyIndex);
        var restarted = new FileRunStore(directory);
        Assert.Null(restarted.TryClaim("worker"));
        restarted.RecoverIndexes();
        var recovered = restarted.TryClaim("worker");
        Assert.Equal(second.RunId, recovered!.RunId.ToString("D"));
    }

    [Fact]
    public void Submit_new_key_does_not_scan_completed_history()
    {
        var store = new FileRunStore(directory);
        var first = store.Submit(Request(), "operator", "first");
        store.Complete(store.TryClaim("worker")!, Result());
        var runPath = Path.Combine(directory, "runs", Guid.Parse(first.RunId).ToString("N") + ".json");
        var original = File.ReadAllBytes(runPath);
        File.WriteAllText(runPath, "{not valid json");
        try
        {
            // The former per-new-key ReadRuns() repair would throw on this corrupt, unrelated Run.
            var second = store.Submit(Request(), "operator", "second");
            Assert.NotEqual(first.RunId, second.RunId);
        }
        finally
        {
            File.WriteAllBytes(runPath, original);
        }
    }

    [Fact]
    public void Idempotency_replay_recovers_after_lost_index_with_corrupt_unrelated_run()
    {
        var store = new FileRunStore(directory);
        var original = store.Submit(Request(), "operator", "key");
        var unrelated = store.Submit(Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } }, "operator", "unrelated");
        store.Complete(store.TryClaim("worker")!, Result());
        File.WriteAllText(Path.Combine(directory, "runs", Guid.Parse(unrelated.RunId).ToString("N") + ".json"), "{not valid json");
        Directory.Delete(Path.Combine(directory, "idempotency"), recursive: true);
        // One-time reconciliation must recover the surviving Run instead of failing on the corrupt record.
        var replay = new FileRunStore(directory).Submit(Request(), "operator", "key");
        Assert.Equal(original.RunId, replay.RunId);
    }

    [Fact]
    public void RecoverIndexes_repairs_both_indexes_from_run_records()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var missingRunId = Guid.NewGuid();
        var pendingPath = Path.Combine(directory, "pending-index.json");
        var pending = JsonNode.Parse(File.ReadAllText(pendingPath))!.AsObject();
        pending["entries"]!.AsArray().Add(new JsonObject
        {
            ["runId"] = missingRunId.ToString("D"),
            ["fabId"] = FabId,
            ["order"] = 0,
            ["createdAtUtc"] = "2026-01-01T00:00:00+00:00",
            ["status"] = "QUEUED",
            ["expiresAtUtc"] = "2026-01-01T00:00:00+00:00"
        });
        File.WriteAllText(pendingPath, pending.ToJsonString());
        var idempotencyDirectory = Path.Combine(directory, "idempotency");
        var realShard = Path.GetFileNameWithoutExtension(Assert.Single(Directory.GetFiles(idempotencyDirectory, "*.json")));
        var staleShardPath = Path.Combine(idempotencyDirectory, (realShard == "00" ? "01" : "00") + ".json");
        File.WriteAllText(staleShardPath, "{\"FAKE-SCOPE\":{\"runId\":\"" + missingRunId.ToString("D") + "\",\"requestHash\":\"fake\"}}");
        var legacyPath = Path.Combine(directory, "idempotency-index.json");
        File.WriteAllText(legacyPath, "{\"LEGACY-FAKE\":{\"runId\":\"" + missingRunId.ToString("D") + "\",\"requestHash\":\"fake\"}}");

        store.RecoverIndexes();

        var pendingText = File.ReadAllText(pendingPath);
        Assert.Contains(run.RunId, pendingText);
        Assert.DoesNotContain(missingRunId.ToString("D"), pendingText);
        Assert.False(File.Exists(staleShardPath));
        Assert.False(File.Exists(legacyPath));
        var shardText = string.Concat(Directory.GetFiles(idempotencyDirectory, "*.json").Select(File.ReadAllText));
        Assert.DoesNotContain(missingRunId.ToString("D"), shardText);
        Assert.DoesNotContain("FAKE-SCOPE", shardText);
        Assert.Equal(run.RunId, store.Submit(Request(), "operator", "key").RunId);

        // A claimed execution survives recovery as RUNNING with its lease expiry, so nobody can steal it.
        var lease = store.TryClaim("worker")!;
        store.RecoverIndexes();
        Assert.Contains(lease.RunId.ToString("D"), File.ReadAllText(pendingPath));
        Assert.Null(new FileRunStore(directory).TryClaim("competitor"));
    }

    [Fact]
    public void Submit_writes_an_idempotency_shard_and_no_legacy_global_index()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        Assert.False(File.Exists(Path.Combine(directory, "idempotency-index.json")));
        var shardPath = Assert.Single(Directory.GetFiles(Path.Combine(directory, "idempotency"), "*.json"));
        var prefix = Path.GetFileNameWithoutExtension(shardPath);
        Assert.Equal(2, prefix.Length);
        Assert.All(prefix, value => Assert.True(Uri.IsHexDigit(value)));
        Assert.Contains(run.RunId, File.ReadAllText(shardPath));
    }

    [Fact]
    public void Sharded_index_preserves_replay_and_conflict_across_restart()
    {
        var original = new FileRunStore(directory).Submit(Request(), "operator", "key");
        var restarted = new FileRunStore(directory);
        Assert.Equal(original.RunId, restarted.Submit(Request(), "operator", "key").RunId);
        var changed = Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } };
        Assert.Throws<IdempotencyConflictException>(() => restarted.Submit(changed, "operator", "key"));
        Assert.Throws<IdempotencyConflictException>(() => new FileRunStore(directory).Submit(changed, "operator", "key"));
        Assert.Equal(original.RunId, new FileRunStore(directory).Submit(Request(), "operator", "key").RunId);
    }

    [Fact]
    public void Lost_idempotency_shards_are_rebuilt_by_next_submit_or_recovery()
    {
        var store = new FileRunStore(directory);
        var run = store.Submit(Request(), "operator", "key");
        var shardPath = Assert.Single(Directory.GetFiles(Path.Combine(directory, "idempotency"), "*.json"));
        File.Delete(shardPath);
        // The same instance saw this shard before, so it rebuilds from Run records before deciding replay.
        Assert.Equal(run.RunId, store.Submit(Request(), "operator", "key").RunId);
        Assert.True(File.Exists(shardPath));

        var idempotencyDirectory = Path.Combine(directory, "idempotency");
        Directory.Delete(idempotencyDirectory, recursive: true);
        var restarted = new FileRunStore(directory);
        restarted.RecoverIndexes();
        Assert.Equal(run.RunId, restarted.Submit(Request(), "operator", "key").RunId);
        Assert.Equal(run.RunId, new FileRunStore(directory).Submit(Request(), "operator", "key").RunId);
    }

    [Fact]
    public void Legacy_global_index_is_rebuilt_from_runs_and_removed()
    {
        var store = new FileRunStore(directory);
        var original = store.Submit(Request(), "operator", "key");
        var shardPath = Assert.Single(Directory.GetFiles(Path.Combine(directory, "idempotency"), "*.json"));
        // The legacy global index has the same scope -> entry shape as a single shard.
        var legacyBytes = File.ReadAllBytes(shardPath);
        Directory.Delete(Path.Combine(directory, "idempotency"), recursive: true);
        var legacyPath = Path.Combine(directory, "idempotency-index.json");
        File.WriteAllBytes(legacyPath, legacyBytes);
        var migrated = new FileRunStore(directory);
        migrated.RecoverIndexes();
        Assert.False(File.Exists(legacyPath));
        Assert.True(File.Exists(shardPath));
        var changed = Request() with { Scenario = Request().Scenario with { MasterSeed = "43" } };
        Assert.Throws<IdempotencyConflictException>(() => migrated.Submit(changed, "operator", "key"));
        Assert.Equal(original.RunId, migrated.Submit(Request(), "operator", "key").RunId);
        Assert.Equal(original.RunId, new FileRunStore(directory).Submit(Request(), "operator", "key").RunId);
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
