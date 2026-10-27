using Fab.Site;

namespace Fab.App;

/// <summary>One telemetry entity reading inside a telemetry.frame payload.</summary>
public sealed record TelemetrySampleDto(string EntityId, TelemetrySampleValuesDto Values);

/// <summary>Numeric entity values; every value stays a number for the realtime wire decoder.</summary>
public sealed record TelemetrySampleValuesDto(int State, double Utilization);

/// <summary>Aggregate telemetry frame at roughly 20 Hz. Samples stay small so the preview stream stays cheap.</summary>
public sealed record TelemetryFramePayloadDto(string FabId, long Sequence, string CapturedAt, TelemetrySampleDto[] Samples);

/// <summary>SSE envelope of the telemetry.frame topic.</summary>
public sealed record TelemetryFrameEnvelopeDto(string Topic, long Sequence, TelemetryFramePayloadDto Payload);

/// <summary>
/// Development-only synthetic telemetry feed. It mirrors the shape of the realtime
/// telemetry.frame topic already consumed by the preview, at a deliberately low
/// aggregate rate (~20 Hz, 16 entities per frame), and is meant to be replaced by a
/// real SECS/GEM or OPC-UA adapter later.
/// </summary>
public sealed class TelemetrySimulationService
{
    public const string FrameTopic = "telemetry.frame";
    public const int EntityCount = 16;
    public const int FrameIntervalMilliseconds = 50;
    public const int StateCount = 4;

    private readonly SiteDirectory directory;

    public TelemetrySimulationService(SiteDirectory directory)
    {
        ArgumentNullException.ThrowIfNull(directory);
        this.directory = directory;
    }

    /// <summary>Resolves the single FAB of a Site; returns false for an unknown Site.</summary>
    public bool TryGetFabId(Guid siteId, out string fabId)
    {
        if (directory.TryGetSite(siteId, out var site))
        {
            fabId = site.Fabs[0].Id.ToString("D");
            return true;
        }
        fabId = "";
        return false;
    }

    /// <summary>Builds one aggregate frame. Values are synthetic; sequence is supplied by the stream.</summary>
    public TelemetryFrameEnvelopeDto CreateFrame(string fabId, long sequence, DateTimeOffset? capturedAt = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fabId);
        var samples = new TelemetrySampleDto[EntityCount];
        for (var index = 0; index < samples.Length; index++)
        {
            samples[index] = new TelemetrySampleDto(
                $"equipment-{index}",
                new TelemetrySampleValuesDto(
                    Random.Shared.Next(StateCount),
                    Math.Round(Random.Shared.NextDouble(), 3)));
        }
        return new TelemetryFrameEnvelopeDto(
            FrameTopic,
            sequence,
            new TelemetryFramePayloadDto(fabId, sequence, (capturedAt ?? DateTimeOffset.UtcNow).ToString("O"), samples));
    }
}
