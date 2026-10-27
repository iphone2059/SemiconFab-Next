using System.Globalization;
using Fab.Site;
using Microsoft.Extensions.Options;

namespace Fab.App;

/// <summary>Command capability of one equipment entry in one FAB.</summary>
public sealed record EquipmentCapability(
    string EquipmentId,
    IReadOnlySet<string> AllowedActions,
    IReadOnlyDictionary<string, string> StatePreconditions);

/// <summary>
/// Read-only seam for the configured equipment/action capability model. The command
/// endpoint validates targets through this catalog; real deployments replace the
/// development catalog with a SECS/GEM or SEMI E30 model adapter.
/// </summary>
public interface IEquipmentCapabilityCatalog
{
    bool TryGetCapability(Guid siteId, FabUnit fab, string equipmentId, out EquipmentCapability capability);
}

/// <summary>One explicitly configured equipment entry (config section Fab:EquipmentCapabilities).</summary>
public sealed class EquipmentCapabilityEntryOptions
{
    /// <summary>Allowed action tokens (ASCII letters, digits, '-' or '_'), e.g. START/STOP/PAUSE. At least one.</summary>
    public string[] Actions { get; set; } = [];

    /// <summary>Optional preconditions: action token -> required current equipment state (e.g. STOP -> running).</summary>
    public Dictionary<string, string> Preconditions { get; set; } = new(StringComparer.Ordinal);
}

/// <summary>Explicit equipment capability catalog for one FAB code.</summary>
public sealed class EquipmentCapabilityFabOptions
{
    public Dictionary<string, EquipmentCapabilityEntryOptions> Equipment { get; set; } = new(StringComparer.Ordinal);
}

/// <summary>
/// Configuration for the development equipment capability catalog
/// (configuration section <c>Fab:EquipmentCapabilities</c>).
///
/// FABs listed under <see cref="Fabs"/> use only their configured entries (so an explicit
/// catalog can restrict or rename equipment); every other FAB falls back to the generated
/// synthetic catalog. Default fallback: equipment-0..equipment-120, actions START/STOP/PAUSE,
/// no preconditions - exactly the surface the preview and existing tests rely on.
/// </summary>
public sealed class EquipmentCapabilityCatalogOptions
{
    public string EquipmentPrefix { get; set; } = "equipment-";

    public int EquipmentCount { get; set; } = 121;

    public string[] DefaultActions { get; set; } = ["START", "STOP", "PAUSE"];

    public Dictionary<string, EquipmentCapabilityFabOptions> Fabs { get; set; } = new(StringComparer.Ordinal);
}

/// <summary>
/// Catalog built from <see cref="EquipmentCapabilityCatalogOptions"/> at startup. Invalid
/// configuration fails fast instead of silently widening command access.
/// </summary>
public sealed class EquipmentCapabilityCatalog : IEquipmentCapabilityCatalog
{
    private static readonly IReadOnlyDictionary<string, string> NoPreconditions =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private readonly Dictionary<string, EquipmentCapability> defaultEquipment;
    private readonly Dictionary<string, Dictionary<string, EquipmentCapability>> fabEquipment;

    public EquipmentCapabilityCatalog(IOptions<EquipmentCapabilityCatalogOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var settings = options.Value ?? throw Invalid("no options were bound.");
        defaultEquipment = BuildDefaultEquipment(settings);
        fabEquipment = new Dictionary<string, Dictionary<string, EquipmentCapability>>(StringComparer.Ordinal);
        foreach (var pair in settings.Fabs ?? new Dictionary<string, EquipmentCapabilityFabOptions>())
        {
            if (string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 64 || pair.Key.Any(char.IsControl))
                throw Invalid("FAB codes must be 1..64 printable characters.");
            if (fabEquipment.ContainsKey(pair.Key)) throw Invalid($"duplicate FAB code '{pair.Key}'.");
            var entries = new Dictionary<string, EquipmentCapability>(StringComparer.Ordinal);
            foreach (var entryPair in pair.Value?.Equipment ?? new Dictionary<string, EquipmentCapabilityEntryOptions>())
            {
                if (string.IsNullOrWhiteSpace(entryPair.Key) || entryPair.Key.Length > 128 || entryPair.Key.Any(char.IsControl))
                    throw Invalid($"equipment ids must be 1..128 printable characters (FAB {pair.Key}).");
                entries.Add(entryPair.Key, BuildCapability(entryPair.Key, entryPair.Value, pair.Key));
            }
            fabEquipment.Add(pair.Key, entries);
        }
    }

    public bool TryGetCapability(Guid siteId, FabUnit fab, string equipmentId, out EquipmentCapability capability)
    {
        ArgumentNullException.ThrowIfNull(fab);
        if (!string.IsNullOrEmpty(equipmentId) && fabEquipment.TryGetValue(fab.Code, out var configured))
            return configured.TryGetValue(equipmentId, out capability!);
        return defaultEquipment.TryGetValue(equipmentId ?? "", out capability!);
    }

    private static Dictionary<string, EquipmentCapability> BuildDefaultEquipment(EquipmentCapabilityCatalogOptions settings)
    {
        if (settings.EquipmentCount is < 1 or > 10_000)
            throw Invalid("EquipmentCount must be 1..10000.");
        if (string.IsNullOrWhiteSpace(settings.EquipmentPrefix) || settings.EquipmentPrefix.Length > 64 ||
            settings.EquipmentPrefix.Any(char.IsControl))
            throw Invalid("EquipmentPrefix must be a non-empty printable string of at most 64 characters.");
        var actions = NormalizeActions(settings.DefaultActions, "DefaultActions");
        var defaults = new Dictionary<string, EquipmentCapability>(StringComparer.Ordinal);
        for (var index = 0; index < settings.EquipmentCount; index++)
        {
            var equipmentId = settings.EquipmentPrefix + index.ToString(CultureInfo.InvariantCulture);
            defaults[equipmentId] = new EquipmentCapability(equipmentId, actions, NoPreconditions);
        }
        return defaults;
    }

    private static EquipmentCapability BuildCapability(string equipmentId, EquipmentCapabilityEntryOptions? entry, string fabCode)
    {
        if (entry is null) throw Invalid($"FAB {fabCode} equipment '{equipmentId}' has no entry body.");
        var actions = NormalizeActions(entry.Actions, $"FAB {fabCode} equipment '{equipmentId}' Actions");
        var preconditions = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in entry.Preconditions ?? new Dictionary<string, string>())
        {
            if (!actions.Contains(pair.Key))
                throw Invalid($"FAB {fabCode} equipment '{equipmentId}' declares a precondition for '{pair.Key}', which is not an allowed action.");
            if (string.IsNullOrWhiteSpace(pair.Value) || pair.Value.Length > 64 || pair.Value.Any(char.IsControl))
                throw Invalid($"FAB {fabCode} equipment '{equipmentId}' precondition for '{pair.Key}' must be 1..64 printable characters.");
            preconditions[pair.Key] = pair.Value;
        }
        return new EquipmentCapability(equipmentId, actions, preconditions);
    }

    private static IReadOnlySet<string> NormalizeActions(IEnumerable<string>? actions, string where)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var action in actions ?? [])
        {
            if (string.IsNullOrWhiteSpace(action) || action.Length > 64 ||
                action.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not ('-' or '_')))
                throw Invalid($"{where} contains an invalid action token.");
            if (!set.Add(action)) throw Invalid($"{where} contains duplicate action '{action}'.");
        }
        if (set.Count == 0) throw Invalid($"{where} must declare at least one action.");
        return set;
    }

    private static InvalidOperationException Invalid(string message) =>
        new("Invalid Fab:EquipmentCapabilities configuration: " + message);
}
