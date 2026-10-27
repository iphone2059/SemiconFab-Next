using System.Collections.Concurrent;
using System.Security.Cryptography;
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
/// Development-only synthetic telemetry feed. Frames are produced per FAB and the numeric
/// sample state is derived from the same <see cref="EquipmentStatusService"/> snapshot that
/// serves the equipment-status endpoints (equipment-&lt;i&gt; maps to tools[i]), so both views
/// always agree. Utilization remains a per-FAB deterministic synthetic value. The wire shape
/// matches the realtime telemetry.frame topic at ~20 Hz with 16 entities per frame and is
/// meant to be replaced by a real SECS/GEM or OPC-UA adapter later.
/// </summary>
public sealed class TelemetrySimulationService
{
    public const string FrameTopic = "telemetry.frame";
    public const int EntityCount = 16;
    public const int FrameIntervalMilliseconds = 50;
    public const int StateCount = 4;

    private readonly SiteDirectory directory;
    private readonly EquipmentStatusService status;
    private readonly ConcurrentDictionary<Guid, FabTelemetryState> states = new();

    public TelemetrySimulationService(SiteDirectory directory, EquipmentStatusService status)
    {
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(status);
        this.directory = directory;
        this.status = status;
    }

    /// <summary>Resolves a requested Site/FAB pair; returns false when either is unknown or mismatched.</summary>
    public bool TryGetFab(Guid siteId, Guid fabId, out FabUnit fab) => directory.TryGetFab(siteId, fabId, out fab);

    /// <summary>
    /// Builds one aggregate frame for a FAB. The sequence is supplied by the connection.
    /// <paramref name="capturedAt"/> pins both the frame timestamp and the equipment-status
    /// bucket, which makes state-unification assertions deterministic in tests.
    /// </summary>
    public TelemetryFrameEnvelopeDto CreateFrame(Guid siteId, Guid fabId, long sequence, DateTimeOffset? capturedAt = null)
    {
        var instant = capturedAt ?? DateTimeOffset.UtcNow;
        var snapshot = status.Get(siteId, fabId, instant);
        var state = states.GetOrAdd(fabId, id => new FabTelemetryState(SeedFor(id)));
        var samples = new TelemetrySampleDto[EntityCount];
        lock (state.Gate)
        {
            for (var index = 0; index < samples.Length; index++)
            {
                var toolState = index < snapshot.Tools.Length ? snapshot.Tools[index].State : "running";
                samples[index] = new TelemetrySampleDto(
                    $"equipment-{index}",
                    new TelemetrySampleValuesDto(MapState(toolState), Math.Round(state.Random.NextDouble(), 3)));
            }
            state.Frames++;
        }
        return new TelemetryFrameEnvelopeDto(
            FrameTopic,
            sequence,
            new TelemetryFramePayloadDto(fabId.ToString("D"), sequence, instant.ToString("O"), samples));
    }

    /// <summary>Maps synthetic tool state strings onto the numeric telemetry state enum.</summary>
    public static int MapState(string? state) => state switch
    {
        "running" => 0,
        "idle" => 1,
        "down" => 2,
        "maint" => 3,
        _ => 0
    };

    private static int SeedFor(Guid fabId) => BitConverter.ToInt32(SHA256.HashData(fabId.ToByteArray()), 0);

    private sealed class FabTelemetryState
    {
        public readonly object Gate = new();
        public readonly Random Random;
        public long Frames;

        public FabTelemetryState(int seed) => Random = new Random(seed);
    }
}
