using System.Globalization;
using Fab.Site;

namespace Fab.App;

/// <summary>Result of validating one command target against the equipment model.</summary>
public sealed record EquipmentCommandValidationResult(bool IsValid, string? Title, string? Detail)
{
    public static EquipmentCommandValidationResult Valid() => new(true, null, null);

    public static EquipmentCommandValidationResult Invalid(string title, string detail) => new(false, title, detail);
}

/// <summary>
/// Seam for validating a command against the configured Site/FAB equipment model.
/// Real deployments replace the synthetic implementation with a SECS/GEM or E30 model adapter.
/// </summary>
public interface IEquipmentCommandValidator
{
    EquipmentCommandValidationResult Validate(Guid siteId, FabUnit fab, EquipmentCommandRequest request);
}

/// <summary>
/// Development-only synthetic equipment model: every demo FAB exposes equipment-0..equipment-120
/// (matching the 121-tool synthetic status feed) and supports START/STOP/PAUSE.
/// </summary>
public sealed class SyntheticEquipmentCommandValidator : IEquipmentCommandValidator
{
    public const int EquipmentCount = 121;
    public const string EquipmentPrefix = "equipment-";
    public static readonly string[] SupportedActions = ["START", "STOP", "PAUSE"];

    private static readonly HashSet<string> Actions = new(SupportedActions, StringComparer.Ordinal);

    public EquipmentCommandValidationResult Validate(Guid siteId, FabUnit fab, EquipmentCommandRequest request)
    {
        ArgumentNullException.ThrowIfNull(fab);
        ArgumentNullException.ThrowIfNull(request);

        if (!TryParseEquipmentId(request.EquipmentId, out _))
            return EquipmentCommandValidationResult.Invalid(
                "Unknown equipment",
                $"equipmentId must identify a synthetic tool of FAB {fab.Code}: equipment-0..equipment-{EquipmentCount - 1}.");
        if (!Actions.Contains(request.Action))
            return EquipmentCommandValidationResult.Invalid(
                "Unsupported action",
                $"action must be one of {string.Join(", ", SupportedActions)}.");
        return EquipmentCommandValidationResult.Valid();
    }

    /// <summary>Accepts only canonical ids equipment-0..equipment-120 (no padding, signs or whitespace).</summary>
    public static bool TryParseEquipmentId(string? equipmentId, out int index)
    {
        index = -1;
        if (string.IsNullOrEmpty(equipmentId) || !equipmentId.StartsWith(EquipmentPrefix, StringComparison.Ordinal)) return false;
        var suffix = equipmentId.AsSpan(EquipmentPrefix.Length);
        if (suffix.Length is 0 or > 3 || !int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)) return false;
        if (parsed >= EquipmentCount) return false;
        if (!string.Equals(equipmentId, EquipmentPrefix + parsed.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)) return false;
        index = parsed;
        return true;
    }
}
