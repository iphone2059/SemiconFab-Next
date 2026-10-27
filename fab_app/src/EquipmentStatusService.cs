using System.Collections.Concurrent;

namespace Fab.App;

public sealed record EquipmentStatusItemDto(string State);

public sealed record EquipmentStatusSnapshotDto(string SiteId, string FabId, string GeneratedAt, long Sequence, EquipmentStatusItemDto[] Tools, long Epoch);

/// <summary>
/// Development-only synthetic equipment feed. It gives the preview a server-backed,
/// time-varying status stream that can later be replaced by a real SEMI E10 adapter.
///
/// Snapshots are stable within an eight-second simulation bucket and carry an
/// independent per-FAB monotonic sequence, so REST and SSE consumers of one FAB never
/// observe another FAB's ordering (including when several FABs are streamed at once).
/// </summary>
public sealed class EquipmentStatusService
{
    public const int ToolCount = 121;
    // Unit consumers can remain in-memory; the API always supplies its configured
    // data directory so generations persist across server processes/restarts.
    private static long inMemoryEpoch;
    private readonly long epoch;

    public EquipmentStatusService(string? epochDirectory = null)
    {
        epoch = epochDirectory is null
            ? Interlocked.Increment(ref inMemoryEpoch)
            : EquipmentStatusEpoch.Allocate(epochDirectory);
    }

    private readonly ConcurrentDictionary<Guid, FabState> states = new();

    private sealed class FabState
    {
        public long Bucket;
        public long Sequence;
        public EquipmentStatusSnapshotDto? Snapshot;
    }

    public EquipmentStatusSnapshotDto Get(Guid siteId, Guid fabId, DateTimeOffset? now = null)
    {
        var instant = now ?? DateTimeOffset.UtcNow;
        var bucket = instant.ToUnixTimeSeconds() / 8;
        var state = states.GetOrAdd(fabId, _ => new FabState());
        lock (state)
        {
            if (state.Snapshot is null || bucket > state.Bucket)
            {
                state.Bucket = bucket;
                state.Sequence++;
                // Per-FAB salt keeps neighbouring FABs visually independent while staying deterministic.
                var salt = (int)(BitConverter.ToUInt32(fabId.ToByteArray(), 0) % 23);
                var tools = Enumerable.Range(0, ToolCount).Select(index =>
                {
                    var phase = (index * 7 + (int)(bucket % 17) + salt) % 23;
                    var toolState = phase == 0 ? "down"
                        : phase is 1 or 2 ? "maint"
                        : phase < 7 ? "idle"
                        : "running";
                    return new EquipmentStatusItemDto(toolState);
                }).ToArray();
                var generatedAt = DateTimeOffset.FromUnixTimeSeconds(bucket * 8);
                state.Snapshot = new EquipmentStatusSnapshotDto(
                    siteId.ToString("D"), fabId.ToString("D"), generatedAt.ToString("O"), state.Sequence, tools, epoch);
            }

            return state.Snapshot;
        }
    }
}
