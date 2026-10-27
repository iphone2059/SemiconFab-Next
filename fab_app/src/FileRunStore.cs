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
    private const int PendingIndexVersion = 1;
    private static readonly TimeSpan PendingIndexRebuildInterval = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string directory;
    private readonly string runsDirectory;
    private readonly string resultsDirectory;
    private readonly string idempotencyDirectory;
    private readonly string pendingIndexPath;
    // Capacity one: submissions coalesce into a single pending wakeup so a worker that is busy
    // claiming never accumulates a burst of empty claims after a large batch drains. The durable
    // pending index remains the source of truth; this signal is only a latency optimization.
    private readonly SemaphoreSlim submittedWork = new(0, 1);
    private readonly TimeProvider clock;
    private readonly HashSet<string> knownIdempotencyShards = new(StringComparer.Ordinal);
    private volatile bool idempotencyIndexReconciled;
    public TimeSpan LeaseDuration { get; }
    private string LegacyIdempotencyIndexPath => Path.Combine(directory, "idempotency-index.json");

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
        idempotencyDirectory = Path.Combine(this.directory, "idempotency");
        pendingIndexPath = Path.Combine(this.directory, "pending-index.json");
        Directory.CreateDirectory(runsDirectory);
        Directory.CreateDirectory(resultsDirectory);
        Directory.CreateDirectory(idempotencyDirectory);
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
        // A process death between publishing a Run and its idempotency entry is repaired by one
        // history scan per store instance, never by a scan on every new idempotency key.
        ReconcileIdempotencyIndexOnce();
        var shardPrefix = ShardPrefix(scope);
        var shard = LoadIdempotencyShard(shardPrefix);
        if (shard.TryGetValue(scope, out var existing))
        {
            if (existing.RequestHash != requestHash) throw new IdempotencyConflictException("The idempotency key already identifies a different request.");
            // A replayed Submit may be retrying a Run that is still queued, so idle workers are notified too.
            SignalSubmittedWork();
            return CreationSummary(ReadRun(existing.RunId) ?? throw new InvalidDataException("Idempotency index references a missing Run."));
        }
        var record = new StoredRun
        {
            Id = Guid.NewGuid(), Scope = scope, RequestHash = requestHash, Request = frozen,
            CreatedAtUtc = clock.GetUtcNow(), Version = 1,
            Executions = frozen.Scenario.Fabs.Select(fab => new StoredExecution { FabId = fab.FabId, Code = fab.Code, TotalLots = fab.LotCount }).ToArray()
        };
        Save(record);
        shard.Add(scope, new IdempotencyEntry(record.Id, requestHash));
        // Only this one shard is rewritten; Submit never touches the rest of the history. Shard size
        // still grows with the idempotency records hashing to the same prefix (about 1/256 of the
        // total under uniform hashing), which is orders below the single-file index this replaced.
        AtomicWrite(IdempotencyShardPath(shardPrefix), Serialize(shard));
        knownIdempotencyShards.Add(shardPrefix);
        // Publish the claimable executions after the Run is durable. If the process dies between the
        // two writes, a later pending-index rebuild repairs the index from the Run records.
        var pending = TryLoadPendingIndex();
        if (pending is null) pending = RebuildPendingIndex(record.CreatedAtUtc);
        else AppendPendingEntries(pending, record);
        WritePendingIndex(pending);
        SignalSubmittedWork();
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

    /// <summary>Waits until this store instance learns about submitted work, the timeout elapses, or the token is cancelled.
    /// Returns true when a coalesced submit notification was consumed, false on timeout.</summary>
    public async Task<bool> WaitForWorkAsync(TimeSpan timeout, CancellationToken token)
    {
        if (timeout < TimeSpan.Zero && timeout != Timeout.InfiniteTimeSpan) throw new ArgumentOutOfRangeException(nameof(timeout));
        return await submittedWork.WaitAsync(timeout, token);
    }

    /// <summary>Signals at most one pending wakeup; a burst of Submits coalesces into one notification.</summary>
    private void SignalSubmittedWork()
    {
        try { submittedWork.Release(); }
        catch (SemaphoreFullException) { }
    }

    /// <summary>Forces authoritative recovery of both persisted indexes from the Run records (used at worker startup).</summary>
    public void RecoverIndexes()
    {
        using var gate = AcquireLock();
        ReconcileIdempotencyIndex();
        idempotencyIndexReconciled = true;
        WritePendingIndex(RebuildPendingIndex(clock.GetUtcNow(), tolerateUnreadableRuns: true));
    }

    public ExecutionLease? TryClaim(string owner)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);
        using var gate = AcquireLock();
        // The index is a cache: it is re-read under the lock, candidates are ordered exactly like the
        // original full scan, and every candidate is re-verified against its Run record before claiming.
        var now = clock.GetUtcNow();
        var index = TryLoadPendingIndex();
        var dirty = false;
        if (index is null || now - index.RebuiltAtUtc > PendingIndexRebuildInterval)
        {
            index = RebuildPendingIndex(now);
            dirty = true;
        }
        var candidates = index.Entries
            .Where(entry => entry.Status == "QUEUED" || (entry.Status == "RUNNING" && entry.ExpiresAtUtc <= now))
            .OrderBy(entry => entry.CreatedAtUtc).ThenBy(entry => entry.RunId).ThenBy(entry => entry.Order)
            .ToArray();
        foreach (var entry in candidates)
        {
            var run = ReadRun(entry.RunId);
            var execution = run?.Executions.FirstOrDefault(candidate => candidate.FabId == entry.FabId);
            if (run is null || execution is null || execution.Status is "COMPLETED" or "FAILED")
            {
                RemovePendingEntry(index, entry);
                dirty = true;
                continue;
            }
            if (execution.Status != "QUEUED" && (execution.Status != "RUNNING" || execution.ExpiresAtUtc > now))
            {
                // The cached entry was stale: another process claimed or renewed the lease and already
                // refreshed the index, or the file changed underneath us. Only the Run record is authoritative.
                if (ApplyExecutionState(entry, execution)) dirty = true;
                continue;
            }
            execution.Status = "RUNNING";
            execution.Owner = owner;
            execution.Epoch = checked(execution.Epoch + 1);
            execution.ExpiresAtUtc = now + LeaseDuration;
            run.Version = checked(run.Version + 1);
            Save(run);
            ApplyExecutionState(entry, execution);
            WritePendingIndex(index);
            return new(run.Id, execution.FabId, owner, execution.Epoch, execution.ExpiresAtUtc, run.Request.Scenario);
        }
        if (dirty) WritePendingIndex(index);
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
        PersistLeaseRenewed(run.Id, execution.FabId, execution.ExpiresAtUtc);
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
        PersistExecutionFinished(run.Id, execution.FabId);
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
        PersistExecutionFinished(run.Id, execution.FabId);
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

    private void ReconcileIdempotencyIndexOnce()
    {
        if (idempotencyIndexReconciled) return;
        ReconcileIdempotencyIndex();
        idempotencyIndexReconciled = true;
    }

    /// <summary>Rebuilds idempotency authority from Run records once per instance; first scope by CreatedAtUtc then Id wins.</summary>
    private void ReconcileIdempotencyIndex()
    {
        var authoritative = new Dictionary<string, IdempotencyEntry>();
        foreach (var run in ReadRunsForRecovery().OrderBy(run => run.CreatedAtUtc).ThenBy(run => run.Id))
            authoritative.TryAdd(run.Scope, new IdempotencyEntry(run.Id, run.RequestHash));
        var shards = new Dictionary<string, Dictionary<string, IdempotencyEntry>>(StringComparer.Ordinal);
        foreach (var (scope, entry) in authoritative)
        {
            var prefix = ShardPrefix(scope);
            if (!shards.TryGetValue(prefix, out var shard)) shards[prefix] = shard = [];
            shard[scope] = entry;
        }
        Directory.CreateDirectory(idempotencyDirectory);
        foreach (var (prefix, entries) in shards)
        {
            var existing = TryReadIdempotencyShard(prefix);
            if (existing is not null && IdempotencyIndexesEqual(existing, entries)) continue;
            AtomicWrite(IdempotencyShardPath(prefix), Serialize(entries));
        }
        // A rebuild is authoritative: any file the rebuild did not produce (lost fragments, stale shards,
        // leftover temporary files) is removed so the directory exactly mirrors the Run records.
        foreach (var path in Directory.GetFiles(idempotencyDirectory))
        {
            var prefix = Path.GetFileNameWithoutExtension(path);
            if (path.EndsWith(".json", StringComparison.Ordinal) && shards.ContainsKey(prefix)) continue;
            File.Delete(path);
        }
        // The legacy single-file index is superseded by the shards; drop it only after the shard writes succeeded.
        if (File.Exists(LegacyIdempotencyIndexPath)) File.Delete(LegacyIdempotencyIndexPath);
        knownIdempotencyShards.Clear();
        foreach (var prefix in shards.Keys) knownIdempotencyShards.Add(prefix);
    }

    /// <summary>Recovery must not fail because one historical Run record is unreadable; Get/List still surface the damage.</summary>
    private StoredRun[] ReadRunsForRecovery()
    {
        try { return ReadRuns(); }
        catch (Exception error) when (error is InvalidDataException or JsonException or IOException or UnauthorizedAccessException)
        {
            var runs = new List<StoredRun>();
            foreach (var path in Directory.EnumerateFiles(runsDirectory, "*.json"))
            {
                try { runs.Add(Read<StoredRun>(path)); }
                catch (Exception skipped) when (skipped is InvalidDataException or JsonException or IOException or UnauthorizedAccessException) { }
            }
            return runs.ToArray();
        }
    }

    /// <summary>Loads the shard for a Submit; a lost known shard or an unreadable shard is rebuilt from Run records first.</summary>
    private Dictionary<string, IdempotencyEntry> LoadIdempotencyShard(string prefix)
    {
        var shard = TryReadIdempotencyShard(prefix);
        if (shard is not null)
        {
            knownIdempotencyShards.Add(prefix);
            return shard;
        }
        // A missing shard is normal until a scope hashes to this prefix. A shard this instance saw before,
        // or an unreadable shard file, means the index was lost and must be rebuilt from Run records.
        if (knownIdempotencyShards.Contains(prefix) || File.Exists(IdempotencyShardPath(prefix)))
        {
            ReconcileIdempotencyIndex();
            shard = TryReadIdempotencyShard(prefix);
            if (shard is not null)
            {
                knownIdempotencyShards.Add(prefix);
                return shard;
            }
        }
        return [];
    }

    private Dictionary<string, IdempotencyEntry>? TryReadIdempotencyShard(string prefix)
    {
        var path = IdempotencyShardPath(prefix);
        if (!File.Exists(path)) return null;
        try { return Read<Dictionary<string, IdempotencyEntry>>(path); }
        catch (Exception error) when (error is InvalidDataException or JsonException or IOException or UnauthorizedAccessException) { return null; }
    }

    private string IdempotencyShardPath(string prefix) => Path.Combine(idempotencyDirectory, prefix + ".json");

    private static string ShardPrefix(string scope) => scope[..2];

    private static bool IdempotencyIndexesEqual(Dictionary<string, IdempotencyEntry> left, Dictionary<string, IdempotencyEntry> right) =>
        left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out var entry) && entry == pair.Value);

    /// <summary>Loads the persisted pending index, returning null when it is missing or structurally invalid.</summary>
    private PendingIndex? TryLoadPendingIndex()
    {
        if (!File.Exists(pendingIndexPath)) return null;
        try
        {
            var index = Read<PendingIndex>(pendingIndexPath);
            if (index.Version != PendingIndexVersion || index.Entries is null) return null;
            foreach (var entry in index.Entries)
            {
                if (entry is null || entry.RunId == Guid.Empty || string.IsNullOrWhiteSpace(entry.FabId)) return null;
                if (entry.Status is not ("QUEUED" or "RUNNING")) return null;
                if (entry.Order < 0) return null;
            }
            return index;
        }
        catch (Exception error) when (error is InvalidDataException or JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Full-scan repair: reconstruct the claimable candidate set from the authoritative Run records.</summary>
    private PendingIndex RebuildPendingIndex(DateTimeOffset now, bool tolerateUnreadableRuns = false)
    {
        var entries = new List<PendingEntry>();
        foreach (var run in tolerateUnreadableRuns ? ReadRunsForRecovery() : ReadRuns())
            for (var order = 0; order < run.Executions.Length; order++)
                if (CreatePendingEntry(run, run.Executions[order], order) is { } entry) entries.Add(entry);
        return new PendingIndex { Version = PendingIndexVersion, RebuiltAtUtc = now, Entries = entries.ToArray() };
    }

    private static void AppendPendingEntries(PendingIndex index, StoredRun run)
    {
        var entries = index.Entries.ToList();
        for (var order = 0; order < run.Executions.Length; order++)
        {
            if (CreatePendingEntry(run, run.Executions[order], order) is not { } entry) continue;
            if (entries.Any(existing => existing.RunId == run.Id && existing.FabId == entry.FabId)) continue;
            entries.Add(entry);
        }
        index.Entries = entries.ToArray();
    }

    private static PendingEntry? CreatePendingEntry(StoredRun run, StoredExecution execution, int order) =>
        execution.Status is "QUEUED" or "RUNNING"
            ? new PendingEntry { RunId = run.Id, FabId = execution.FabId, Order = order, CreatedAtUtc = run.CreatedAtUtc, Status = execution.Status, ExpiresAtUtc = execution.ExpiresAtUtc }
            : null;

    private static bool ApplyExecutionState(PendingEntry entry, StoredExecution execution)
    {
        var changed = entry.Status != execution.Status || entry.ExpiresAtUtc != execution.ExpiresAtUtc;
        entry.Status = execution.Status;
        entry.ExpiresAtUtc = execution.ExpiresAtUtc;
        return changed;
    }

    private static void RemovePendingEntry(PendingIndex index, PendingEntry entry) =>
        index.Entries = index.Entries.Where(candidate => candidate.RunId != entry.RunId || candidate.FabId != entry.FabId).ToArray();

    private void PersistLeaseRenewed(Guid runId, string fabId, DateTimeOffset expiresAtUtc)
    {
        var index = TryLoadPendingIndex();
        var entry = index?.Entries.FirstOrDefault(candidate => candidate.RunId == runId && candidate.FabId == fabId);
        if (index is null || entry is null) return;
        if (entry.Status == "RUNNING" && entry.ExpiresAtUtc == expiresAtUtc) return;
        entry.Status = "RUNNING";
        entry.ExpiresAtUtc = expiresAtUtc;
        WritePendingIndex(index);
    }

    private void PersistExecutionFinished(Guid runId, string fabId)
    {
        var index = TryLoadPendingIndex();
        if (index is null) return;
        var remaining = index.Entries.Where(entry => entry.RunId != runId || entry.FabId != fabId).ToArray();
        if (remaining.Length == index.Entries.Length) return;
        index.Entries = remaining;
        WritePendingIndex(index);
    }

    private void WritePendingIndex(PendingIndex index)
    {
        index.Entries = index.Entries.OrderBy(entry => entry.CreatedAtUtc).ThenBy(entry => entry.RunId).ThenBy(entry => entry.Order).ToArray();
        AtomicWrite(pendingIndexPath, Serialize(index));
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

    private sealed class PendingIndex
    {
        public int Version { get; set; }
        public DateTimeOffset RebuiltAtUtc { get; set; }
        public PendingEntry[] Entries { get; set; } = [];
    }

    private sealed class PendingEntry
    {
        public Guid RunId { get; set; }
        public string FabId { get; set; } = "";
        public int Order { get; set; }
        public DateTimeOffset CreatedAtUtc { get; set; }
        public string Status { get; set; } = "QUEUED";
        public DateTimeOffset ExpiresAtUtc { get; set; }
    }
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
