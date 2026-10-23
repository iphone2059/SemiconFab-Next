using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Fab.Contracts;
using Fab.Orchestration;
using Fab.Simulation;

namespace Fab.Orchestration;

/// <summary>Development-only single-machine store. The public constructor permits explicit test use.</summary>
public sealed class FileRunStore : IRunService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string directory;
    private readonly string runsDirectory;
    private readonly string resultsDirectory;
    private readonly TimeProvider clock;
    public TimeSpan LeaseDuration { get; }

    public FileRunStore(string directory, TimeProvider? clock = null, TimeSpan? leaseDuration = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        this.directory = Path.GetFullPath(directory);
        if (this.directory.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Development storage requires a local disk directory.", nameof(directory));
        this.clock = clock ?? TimeProvider.System;
        LeaseDuration = leaseDuration ?? TimeSpan.FromSeconds(30);
        if (LeaseDuration < TimeSpan.FromMilliseconds(100) || LeaseDuration > TimeSpan.FromMinutes(10))
            throw new ArgumentOutOfRangeException(nameof(leaseDuration));
        runsDirectory = Path.Combine(this.directory, "runs");
        resultsDirectory = Path.Combine(this.directory, "results");
        Directory.CreateDirectory(runsDirectory);
        Directory.CreateDirectory(resultsDirectory);
    }

    public RunSummary Submit(CreateRunRequest request, string principal, string key)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(principal);
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        if (principal.Length > 256 || key.Length > 256) throw new ArgumentException("Principal and key are limited to 256 characters.");
        var frozen = Deserialize<CreateRunRequest>(Serialize(request));
        FabSimulation.Validate(frozen.Scenario);
        frozen = frozen with { Scenario = frozen.Scenario with
        {
            SiteId = Guid.Parse(frozen.Scenario.SiteId).ToString("D"),
            Fabs = frozen.Scenario.Fabs.Select(fab => fab with { FabId = Guid.Parse(fab.FabId).ToString("D") }).ToArray()
        } };
        var requestHash = Hash(Serialize(frozen));
        var scope = Hash(Serialize(new[] { frozen.Scenario.SiteId, principal, "CreateRun", key }));
        using var gate = AcquireLock();
        var indexPath = Path.Combine(directory, "idempotency-index.json");
        var index = File.Exists(indexPath) ? Read<Dictionary<string, IdempotencyEntry>>(indexPath) : [];
        if (!index.TryGetValue(scope, out var existing))
        {
            // Repair a process death between publishing a Run and publishing its index entry.
            var orphan = ReadRuns().SingleOrDefault(run => run.Scope == scope);
            if (orphan is not null)
            {
                existing = new(orphan.Id, orphan.RequestHash);
                index.Add(scope, existing);
                AtomicWrite(indexPath, Serialize(index));
            }
        }
        if (existing is not null)
        {
            if (existing.RequestHash != requestHash) throw new IdempotencyConflictException("The idempotency key already identifies a different request.");
            return CreationSummary(ReadRun(existing.RunId) ?? throw new InvalidDataException("Idempotency index references a missing Run."));
        }
        var record = new StoredRun
        {
            Id = Guid.NewGuid(), Scope = scope, RequestHash = requestHash, Request = frozen,
            CreatedAtUtc = clock.GetUtcNow(), Version = 1,
            Executions = frozen.Scenario.Fabs.Select(fab => new StoredExecution { FabId = fab.FabId, Code = fab.Code, TotalLots = fab.LotCount }).ToArray()
        };
        Save(record);
        index.Add(scope, new(record.Id, requestHash));
        AtomicWrite(indexPath, Serialize(index));
        return CreationSummary(record);
    }

    public RunSummary? Get(Guid id)
    {
        using var gate = AcquireLock();
        return ReadRun(id) is { } record ? Summary(record) : null;
    }

    public RunSummary[] List()
    {
        using var gate = AcquireLock();
        return ReadRuns().OrderByDescending(run => run.CreatedAtUtc).ThenBy(run => run.Id).Select(Summary).ToArray();
    }

    public RunResult? GetResults(Guid id)
    {
        using var gate = AcquireLock();
        var run = ReadRun(id);
        return run is not null && run.Executions.All(execution => execution.Status == "COMPLETED")
            ? new RunResult(run.Id.ToString("D"), run.Executions.Select(ReadResult).ToArray()) : null;
    }

    public ExecutionLease? TryClaim(string owner)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);
        using var gate = AcquireLock();
        var now = clock.GetUtcNow();
        foreach (var run in ReadRuns().OrderBy(run => run.CreatedAtUtc).ThenBy(run => run.Id))
        {
            var execution = run.Executions.FirstOrDefault(e => e.Status == "QUEUED" || (e.Status == "RUNNING" && e.ExpiresAtUtc <= now));
            if (execution is null) continue;
            execution.Status = "RUNNING";
            execution.Owner = owner;
            execution.Epoch = checked(execution.Epoch + 1);
            execution.ExpiresAtUtc = now + LeaseDuration;
            run.Version = checked(run.Version + 1);
            Save(run);
            return new(run.Id, execution.FabId, owner, execution.Epoch, execution.ExpiresAtUtc, run.Request.Scenario);
        }
        return null;
    }

    public bool Renew(ExecutionLease lease)
    {
        using var gate = AcquireLock();
        var run = ReadRun(lease.RunId);
        var execution = run?.Executions.SingleOrDefault(e => e.FabId == lease.FabId);
        if (run is null || execution is null || !IsCurrent(execution, lease)) return false;
        var previousExpiration = execution.ExpiresAtUtc;
        execution.ExpiresAtUtc = clock.GetUtcNow() + LeaseDuration;
        run.Version = checked(run.Version + 1);
        try { Save(run, previousExpiration); }
        catch (LeaseLostException) { return false; }
        return true;
    }

    public void Complete(ExecutionLease lease, FabSimulationResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        using var gate = AcquireLock();
        var (run, execution) = RequireCurrent(lease);
        if (result.FabId != execution.FabId || result.TotalLots != execution.TotalLots.ToString(CultureInfo.InvariantCulture))
            throw new ArgumentException("The result does not belong to this frozen FAB execution.", nameof(result));
        var bytes = Serialize(result);
        var resultName = $"{run.Id:N}-{Hash(Serialize(execution.FabId))}-{execution.Epoch}.json";
        // Publish a flushed epoch-specific artifact before the single-file metadata commit.
        AtomicWrite(Path.Combine(resultsDirectory, resultName), bytes);
        if (!IsCurrent(execution, lease)) throw new LeaseLostException("The execution lease expired while writing its result.");
        execution.ResultFile = resultName;
        execution.ResultHash = Hash(bytes);
        execution.Status = "COMPLETED";
        execution.Owner = null;
        run.Version = checked(run.Version + 1);
        Save(run, execution.ExpiresAtUtc);
    }

    public void Fail(ExecutionLease lease, string error)
    {
        using var gate = AcquireLock();
        var (run, execution) = RequireCurrent(lease);
        execution.Status = "FAILED";
        execution.Error = string.IsNullOrWhiteSpace(error) ? "Simulation failed." : error[..Math.Min(error.Length, 2000)];
        execution.Owner = null;
        run.Version = checked(run.Version + 1);
        Save(run, execution.ExpiresAtUtc);
    }

    private bool IsCurrent(StoredExecution execution, ExecutionLease lease) => execution.Status == "RUNNING"
        && execution.Owner == lease.Owner && execution.Epoch == lease.Epoch && execution.ExpiresAtUtc > clock.GetUtcNow();

    private (StoredRun Run, StoredExecution Execution) RequireCurrent(ExecutionLease lease)
    {
        var run = ReadRun(lease.RunId);
        var execution = run?.Executions.SingleOrDefault(e => e.FabId == lease.FabId);
        if (run is null || execution is null || !IsCurrent(execution, lease)) throw new LeaseLostException("The execution lease is no longer current.");
        return (run, execution);
    }

    private static RunSummary CreationSummary(StoredRun run) => new(run.Id.ToString("D"), run.Request.Scenario.SiteId,
        "QUEUED", "1", run.CreatedAtUtc.ToString("O"), run.Executions.Select(execution => new FabExecutionSummary(
            execution.FabId, execution.Code, "QUEUED", "0", execution.TotalLots.ToString(CultureInfo.InvariantCulture), "0", null, null)).ToArray());

    private RunSummary Summary(StoredRun run)
    {
        var summaries = run.Executions.Select(execution =>
        {
            var result = execution.Status == "COMPLETED" ? ReadResult(execution) : null;
            return new FabExecutionSummary(execution.FabId, execution.Code, execution.Status,
                result?.CompletedLots ?? "0", execution.TotalLots.ToString(CultureInfo.InvariantCulture), result?.SimulationTimeUs ?? "0", result?.TraceHash, execution.Error);
        }).ToArray();
        var status = run.Executions.All(e => e.Status == "COMPLETED") ? "COMPLETED"
            : run.Executions.Any(e => e.Status == "FAILED") ? "FAILED"
            : run.Executions.All(e => e.Status == "QUEUED") ? "QUEUED" : "RUNNING";
        return new(run.Id.ToString("D"), run.Request.Scenario.SiteId, status, run.Version.ToString(CultureInfo.InvariantCulture), run.CreatedAtUtc.ToString("O"), summaries);
    }

    private FabSimulationResult ReadResult(StoredExecution execution)
    {
        if (execution.ResultFile is null || execution.ResultFile != Path.GetFileName(execution.ResultFile)) throw new InvalidDataException("Completed execution has no valid result reference.");
        var bytes = File.ReadAllBytes(Path.Combine(resultsDirectory, execution.ResultFile));
        if (Hash(bytes) != execution.ResultHash) throw new InvalidDataException("Result checksum mismatch.");
        return Deserialize<FabSimulationResult>(bytes);
    }

    private FileStream AcquireLock()
    {
        var timeout = Stopwatch.StartNew();
        while (true)
        {
            try { return new FileStream(Path.Combine(directory, ".store.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (timeout.Elapsed < TimeSpan.FromSeconds(10)) { Thread.Sleep(10); }
        }
    }

    private StoredRun? ReadRun(Guid id)
    {
        var path = Path.Combine(runsDirectory, $"{id:N}.json");
        return File.Exists(path) ? Read<StoredRun>(path) : null;
    }
    private StoredRun[] ReadRuns() => Directory.EnumerateFiles(runsDirectory, "*.json").Select(Read<StoredRun>).ToArray();
    private void Save(StoredRun record, DateTimeOffset? leaseExpiration = null) => AtomicWrite(Path.Combine(runsDirectory, $"{record.Id:N}.json"), Serialize(record), () =>
    {
        if (leaseExpiration is { } expires && expires <= clock.GetUtcNow())
            throw new LeaseLostException("The execution lease expired before its metadata commit.");
    });
    private static T Read<T>(string path) => Deserialize<T>(File.ReadAllBytes(path));
    private static T Deserialize<T>(byte[] bytes) => JsonSerializer.Deserialize<T>(bytes, Json) ?? throw new InvalidDataException("Invalid local store record.");
    private static byte[] Serialize<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, Json);
    private static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value));
    private static void AtomicWrite(string path, byte[] bytes, Action? beforePublish = null)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            beforePublish?.Invoke();
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private sealed record IdempotencyEntry(Guid RunId, string RequestHash);
    private sealed class StoredRun
    {
        public Guid Id { get; set; }
        public string Scope { get; set; } = "";
        public string RequestHash { get; set; } = "";
        public CreateRunRequest Request { get; set; } = null!;
        public DateTimeOffset CreatedAtUtc { get; set; }
        public long Version { get; set; }
        public StoredExecution[] Executions { get; set; } = [];
    }
    private sealed class StoredExecution
    {
        public string FabId { get; set; } = "";
        public string Code { get; set; } = "";
        public int TotalLots { get; set; }
        public string Status { get; set; } = "QUEUED";
        public string? Owner { get; set; }
        public long Epoch { get; set; }
        public DateTimeOffset ExpiresAtUtc { get; set; }
        public string? Error { get; set; }
        public string? ResultFile { get; set; }
        public string? ResultHash { get; set; }
    }
}
