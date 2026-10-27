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
/// Development-only synthetic telemetry feed. Frames are produced per FAB: each FAB has
/// its own deterministic random stream and entity state, so two FABs streamed at the same
/// time never share state. The wire shape matches the realtime telemetry.frame topic at a
/// deliberately low aggregate rate (~20 Hz, 16 entities per frame) and is meant to be
/// replaced by a real SECS/GEM or OPC-UA adapter later.
/// </summary>
public sealed class TelemetrySimulationService
{
    public const string FrameTopic = "telemetry.frame";
    public const int EntityCount = 16;
    public const int FrameIntervalMilliseconds = 50;
    public const int StateCount = 4;

    private readonly SiteDirectory directory;
    private readonly ConcurrentDictionary<Guid, FabTelemetryState> states = new();

    public TelemetrySimulationService(SiteDirectory directory)
    {
        ArgumentNullException.ThrowIfNull(directory);
        this.directory = directory;
    }

    /// <summary>Resolves a requested Site/FAB pair; returns false when either is unknown or mismatched.</summary>
    public bool TryGetFab(Guid siteId, Guid fabId, out FabUnit fab) => directory.TryGetFab(siteId, fabId, out fab);

    /// <summary>
    /// Builds one aggregate frame for a FAB. The sequence is supplied by the connection;
    /// each FAB's entity state advances independently across all of its consumers.
    /// </summary>
    public TelemetryFrameEnvelopeDto CreateFrame(Guid fabId, long sequence, DateTimeOffset? capturedAt = null)
    {
        var state = states.GetOrAdd(fabId, id => new FabTelemetryState(SeedFor(id)));
        var samples = new TelemetrySampleDto[EntityCount];
        lock (state.Gate)
        {
            for (var index = 0; index < samples.Length; index++)
            {
                var next = Math.Clamp(state.EntityStates[index] + state.Random.Next(-1, 2), 0, StateCount - 1);
                state.EntityStates[index] = next;
                samples[index] = new TelemetrySampleDto(
                    $"equipment-{index}",
                    new TelemetrySampleValuesDto(next, Math.Round(state.Random.NextDouble(), 3)));
            }
            state.Frames++;
        }
        return new TelemetryFrameEnvelopeDto(
            FrameTopic,
            sequence,
            new TelemetryFramePayloadDto(fabId.ToString("D"), sequence, (capturedAt ?? DateTimeOffset.UtcNow).ToString("O"), samples));
    }

    private static int SeedFor(Guid fabId) => BitConverter.ToInt32(SHA256.HashData(fabId.ToByteArray()), 0);

    private sealed class FabTelemetryState
    {
        public readonly object Gate = new();
        public readonly Random Random;
        public readonly int[] EntityStates = new int[EntityCount];
        public long Frames;

        public FabTelemetryState(int seed)
        {
            Random = new Random(seed);
            for (var index = 0; index < EntityStates.Length; index++) EntityStates[index] = Random.Next(StateCount);
        }
    }
}
