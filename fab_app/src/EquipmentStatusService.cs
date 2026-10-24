using System.Collections.Concurrent;

namespace Fab.App;

public sealed record EquipmentStatusItemDto(string State);

public sealed record EquipmentStatusSnapshotDto(string SiteId, string GeneratedAt, long Sequence, EquipmentStatusItemDto[] Tools);

/// <summary>
/// Development-only synthetic equipment feed. It gives the preview a server-backed,
/// time-varying status stream that can later be replaced by a real SEMI E10 adapter.
///
/// Snapshots are stable within an eight-second simulation bucket and carry a
/// per-site monotonic sequence. REST and SSE consumers can therefore reject late
/// or duplicate frames even when generatedAt timestamps collide.
/// </summary>
public sealed class EquipmentStatusService
{
    private const int ToolCount = 121;
    private readonly ConcurrentDictionary<Guid, SiteState> states = new();

    private sealed class SiteState
    {
        public long Bucket;
        public long Sequence;
        public EquipmentStatusSnapshotDto? Snapshot;
    }

    public EquipmentStatusSnapshotDto Get(Guid siteId, DateTimeOffset? now = null)
    {
        var instant = now ?? DateTimeOffset.UtcNow;
        var bucket = instant.ToUnixTimeSeconds() / 8;
        var state = states.GetOrAdd(siteId, _ => new SiteState());
        lock (state)
        {
            if (state.Snapshot is null || bucket > state.Bucket)
            {
                state.Bucket = bucket;
                state.Sequence++;
                var tools = Enumerable.Range(0, ToolCount).Select(index =>
                {
                    var phase = (index * 7 + (int)(bucket % 17)) % 23;
                    var toolState = phase == 0 ? "down"
                        : phase is 1 or 2 ? "maint"
                        : phase < 7 ? "idle"
                        : "running";
                    return new EquipmentStatusItemDto(toolState);
                }).ToArray();
                var generatedAt = DateTimeOffset.FromUnixTimeSeconds(bucket * 8);
                state.Snapshot = new EquipmentStatusSnapshotDto(
                    siteId.ToString("D"), generatedAt.ToString("O"), state.Sequence, tools);
            }

            return state.Snapshot;
        }
    }
}
