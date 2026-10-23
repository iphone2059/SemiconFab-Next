using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fab.Contracts;
using Fab.Ids;
using Fab.Simulation.Models;

namespace Fab.Simulation.Runtime;

public sealed record SimulationCheckpoint(int SchemaVersion, string StateJson, string Checksum);

public sealed class FabSimulation
{
    public static void Validate(ScenarioDefinition scenario)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        if (scenario.ContractVersion != 1 || scenario.Mode != "INDEPENDENT")
            throw new ArgumentException("Only contract v1 and INDEPENDENT mode are supported.", nameof(scenario));
        StableId.Normalize(scenario.SiteId, nameof(scenario.SiteId));
        ParseSeed(scenario.MasterSeed);
        var duration = ParseTime(scenario.DurationUs, nameof(scenario.DurationUs), true);
        var warmup = ParseTime(scenario.WarmupUs, nameof(scenario.WarmupUs), false);
        if (warmup >= duration) throw new ArgumentException("Warmup must be less than duration.", nameof(scenario));
        if (scenario.Fabs is null || scenario.Fabs.Length is < 1 or > 32)
            throw new ArgumentException("Between 1 and 32 FABs are required.", nameof(scenario));
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var codes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var fab in scenario.Fabs)
        {
            if (fab is null) throw new ArgumentException("Null FAB member.", nameof(scenario));
            if (!ids.Add(StableId.Normalize(fab.FabId, nameof(fab.FabId))))
                throw new ArgumentException("Duplicate FAB ID.", nameof(scenario));
            if (string.IsNullOrWhiteSpace(fab.Code) || fab.Code.Length > 64 || fab.Code.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_') || !codes.Add(fab.Code))
                throw new ArgumentException("FAB codes must be unique ASCII letters, digits, hyphens or underscores (1..64).", nameof(scenario));
            if (fab.LotCount is < 1 or > 10000) throw new ArgumentException("LotCount must be 1..10000.", nameof(scenario));
            var process = ParseTime(fab.ProcessTimeUs, nameof(fab.ProcessTimeUs), true);
            try { _ = checked(checked(process + process / 10) * fab.LotCount); }
            catch (OverflowException ex) { throw new ArgumentException("Worst-case completion time exceeds Int64 microseconds.", nameof(scenario), ex); }
        }
    }

    internal static ulong ParseSeed(string? value)
    {
        if (!Digits(value) || !ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var result))
            throw new ArgumentException("MasterSeed must be a decimal UInt64.", nameof(value));
        return result;
    }

    internal static long ParseTime(string? value, string name, bool positive)
    {
        if (!Digits(value) || !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var result) || (positive && result == 0))
            throw new ArgumentException("Time must be a decimal nonnegative Int64 (positive where required).", name);
        return result;
    }

    private static bool Digits(string? value) => value is { Length: > 0 and <= 20 }
        && (value.Length == 1 || value[0] != '0') && value.All(char.IsAsciiDigit);

    public FabSimulationResult Execute(ScenarioDefinition scenario, string fabId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Start(scenario, fabId).RunToCompletion(cancellationToken);
    }

    public FabSimulationSession Start(ScenarioDefinition scenario, string fabId)
    {
        Validate(scenario);
        var id = StableId.Normalize(fabId, nameof(fabId));
        var member = scenario.Fabs.SingleOrDefault(x => StableId.Normalize(x.FabId, nameof(x.FabId)) == id)
            ?? throw new ArgumentException("Requested FAB is not a scenario member.", nameof(fabId));
        return new(scenario with { Fabs = scenario.Fabs.ToArray() }, new SyntheticFifoModel(id, member.Code, member.LotCount, ParseTime(member.ProcessTimeUs, nameof(member.ProcessTimeUs), true)));
    }

    public FabSimulationSession Resume(SimulationCheckpoint checkpoint)
    {
        ArgumentNullException.ThrowIfNull(checkpoint);
        if (checkpoint.SchemaVersion != 1 || checkpoint.StateJson is null || checkpoint.StateJson.Length > 20_000_000 || checkpoint.Checksum != Digest(checkpoint.StateJson))
            throw new ArgumentException("Incompatible or corrupt checkpoint.", nameof(checkpoint));
        try
        {
            var state = JsonSerializer.Deserialize<SimulationState>(checkpoint.StateJson) ?? throw new ArgumentException("Empty checkpoint.");
            if (state.EngineVersion != FabSimulationSession.EngineVersion || state.EventSequence is < 0 or > 30000)
                throw new ArgumentException("Incompatible engine or invalid event watermark.");
            var replay = Start(state.Scenario, state.FabId);
            for (long i = 0; i < state.EventSequence; i++)
                if (!replay.StepOneEvent()) throw new ArgumentException("Checkpoint exceeds event stream.");
            if (state.Finished && replay.StepOneEvent()) throw new ArgumentException("Checkpoint ended before stream boundary.");
            if (JsonSerializer.Serialize(replay.CaptureState()) != checkpoint.StateJson)
                throw new ArgumentException("Checkpoint state disagrees with deterministic replay.");
            return FabSimulationSession.Restore(state);
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException or NullReferenceException)
        {
            throw new ArgumentException("Invalid checkpoint payload.", nameof(checkpoint), ex);
        }
    }

    internal static string Digest(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}
