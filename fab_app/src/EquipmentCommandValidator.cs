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
/// Real deployments replace the development implementation with a SECS/GEM or E30 adapter.
/// </summary>
public interface IEquipmentCommandValidator
{
    EquipmentCommandValidationResult Validate(Guid siteId, FabUnit fab, EquipmentCommandRequest request);
}

/// <summary>Current observed state of a command target; used only when a capability declares a precondition.</summary>
public interface IEquipmentStateProvider
{
    string? GetState(Guid siteId, FabUnit fab, string equipmentId);
}

/// <summary>
/// Development-only state adapter over the synthetic equipment status feed. Equipment ids
/// follow the canonical <c>equipment-&lt;index&gt;</c> form used by the synthetic status tools.
/// </summary>
public sealed class SyntheticEquipmentStateProvider : IEquipmentStateProvider
{
    public const string EquipmentPrefix = "equipment-";

    private readonly EquipmentStatusService status;

    public SyntheticEquipmentStateProvider(EquipmentStatusService status)
    {
        ArgumentNullException.ThrowIfNull(status);
        this.status = status;
    }

    public string? GetState(Guid siteId, FabUnit fab, string equipmentId)
    {
        ArgumentNullException.ThrowIfNull(fab);
        if (!TryParseEquipmentIndex(equipmentId, out var index)) return null;
        var snapshot = status.Get(siteId, fab.Id);
        return index < snapshot.Tools.Length ? snapshot.Tools[index].State : null;
    }

    /// <summary>Accepts only canonical ids equipment-0..equipment-N (no padding, signs or whitespace).</summary>
    public static bool TryParseEquipmentIndex(string? equipmentId, out int index)
    {
        index = -1;
        if (string.IsNullOrEmpty(equipmentId) || !equipmentId.StartsWith(EquipmentPrefix, StringComparison.Ordinal)) return false;
        var suffix = equipmentId.AsSpan(EquipmentPrefix.Length);
        if (suffix.Length is 0 or > 9 || !int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)) return false;
        if (!string.Equals(equipmentId, EquipmentPrefix + parsed.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)) return false;
        index = parsed;
        return true;
    }
}

/// <summary>
/// Default development validator: resolves the equipment entry from
/// <see cref="IEquipmentCapabilityCatalog"/> and rejects unknown equipment, actions the
/// entry does not allow, and optional state preconditions that the current state does not meet.
/// </summary>
public sealed class EquipmentCommandValidator : IEquipmentCommandValidator
{
    private readonly IEquipmentCapabilityCatalog catalog;
    private readonly IEquipmentStateProvider stateProvider;

    public EquipmentCommandValidator(IEquipmentCapabilityCatalog catalog, IEquipmentStateProvider stateProvider)
    {
        ArgumentNullException.ThrowIfNull(catalog);
        ArgumentNullException.ThrowIfNull(stateProvider);
        this.catalog = catalog;
        this.stateProvider = stateProvider;
    }

    public EquipmentCommandValidationResult Validate(Guid siteId, FabUnit fab, EquipmentCommandRequest request)
    {
        ArgumentNullException.ThrowIfNull(fab);
        ArgumentNullException.ThrowIfNull(request);

        if (!catalog.TryGetCapability(siteId, fab, request.EquipmentId, out var capability))
            return EquipmentCommandValidationResult.Invalid(
                "Unknown equipment",
                $"equipmentId is not a command-capable tool of FAB {fab.Code} in the configured capability catalog.");

        if (!capability.AllowedActions.Contains(request.Action))
            return EquipmentCommandValidationResult.Invalid(
                "Unsupported action",
                $"action '{request.Action}' is not supported by {request.EquipmentId} in FAB {fab.Code}.");

        if (!capability.StatePreconditions.TryGetValue(request.Action, out var requiredState))
            return EquipmentCommandValidationResult.Valid();

        var currentState = stateProvider.GetState(siteId, fab, request.EquipmentId);
        if (currentState is null)
            return EquipmentCommandValidationResult.Invalid(
                "Command precondition not met",
                $"action '{request.Action}' requires equipment state '{requiredState}' but the current state is unavailable.");
        if (!string.Equals(currentState, requiredState, StringComparison.OrdinalIgnoreCase))
            return EquipmentCommandValidationResult.Invalid(
                "Command precondition not met",
                $"action '{request.Action}' requires equipment state '{requiredState}' but current state is '{currentState}'.");
        return EquipmentCommandValidationResult.Valid();
    }
}
