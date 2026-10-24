namespace Fab.App;

public sealed record EquipmentStatusItemDto(string State);

public sealed record EquipmentStatusSnapshotDto(string SiteId, string GeneratedAt, EquipmentStatusItemDto[] Tools);

/// <summary>
/// Development-only synthetic equipment feed. It gives the preview a server-backed,
/// time-varying status stream that can later be replaced by a real SEMI E10 adapter.
/// </summary>
public sealed class EquipmentStatusService
{
    private const int ToolCount = 121;

    public EquipmentStatusSnapshotDto Get(Guid siteId)
    {
        var now = DateTimeOffset.UtcNow;
        var bucket = now.ToUnixTimeSeconds() / 8;
        var tools = Enumerable.Range(0, ToolCount).Select(index =>
        {
            var phase = (index * 7 + (int)(bucket % 17)) % 23;
            var state = phase == 0 ? "down"
                : phase is 1 or 2 ? "maint"
                : phase < 7 ? "idle"
                : "running";
            return new EquipmentStatusItemDto(state);
        }).ToArray();
        return new EquipmentStatusSnapshotDto(siteId.ToString("D"), now.ToString("O"), tools);
    }
}
