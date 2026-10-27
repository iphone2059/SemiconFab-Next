using Fab.App;
using Fab.Site;
using Microsoft.Extensions.Options;
using Xunit;

namespace Fab.Tests;

/// <summary>
/// Unit coverage for the configurable equipment capability catalog and the validator that
/// consumes it: default fallback surface, explicit per-FAB overrides, action restrictions,
/// state preconditions and fail-fast configuration validation.
/// </summary>
public sealed class EquipmentCapabilityCatalogTests
{
    private static readonly Guid SiteId = SiteDirectory.DemoSiteId;
    private static readonly FabUnit Fab01 = SiteDirectory.CreateFab(1);
    private static readonly FabUnit Fab02 = SiteDirectory.CreateFab(2);

    [Fact]
    public void DefaultCatalogCoversSyntheticSurfaceWithStartStopPause()
    {
        var catalog = Catalog(new EquipmentCapabilityCatalogOptions());

        Assert.True(catalog.TryGetCapability(SiteId, Fab01, "equipment-0", out var first));
        Assert.Equal("equipment-0", first.EquipmentId);
        Assert.Equal(new[] { "PAUSE", "START", "STOP" }, first.AllowedActions.OrderBy(action => action, StringComparer.Ordinal).ToArray());
        Assert.Empty(first.StatePreconditions);
        Assert.True(catalog.TryGetCapability(SiteId, Fab02, "equipment-120", out _));

        Assert.False(catalog.TryGetCapability(SiteId, Fab02, "equipment-121", out _));
        Assert.False(catalog.TryGetCapability(SiteId, Fab02, "equipment-007", out _));
        Assert.False(catalog.TryGetCapability(SiteId, Fab02, "tool-0", out _));
    }

    [Fact]
    public void ConfiguredFabOverridesDefaultCatalogAndOtherFabsFallBack()
    {
        var options = new EquipmentCapabilityCatalogOptions();
        var entry = new EquipmentCapabilityEntryOptions { Actions = ["START", "STOP"] };
        entry.Preconditions["STOP"] = "running";
        var fabOptions = new EquipmentCapabilityFabOptions();
        fabOptions.Equipment["equipment-0"] = entry;
        options.Fabs["FAB-01"] = fabOptions;

        var catalog = Catalog(options);

        Assert.True(catalog.TryGetCapability(SiteId, Fab01, "equipment-0", out var custom));
        Assert.Equal(new[] { "START", "STOP" }, custom.AllowedActions.OrderBy(action => action, StringComparer.Ordinal).ToArray());
        Assert.Equal("running", custom.StatePreconditions["STOP"]);
        // An explicitly configured FAB uses only its configured entries.
        Assert.False(catalog.TryGetCapability(SiteId, Fab01, "equipment-1", out _));
        // Other FABs keep the generated synthetic fallback.
        Assert.True(catalog.TryGetCapability(SiteId, Fab02, "equipment-1", out _));
    }

    [Fact]
    public void InvalidCatalogConfigurationFailsFast()
    {
        Assert.Throws<InvalidOperationException>(() => Catalog(new EquipmentCapabilityCatalogOptions { EquipmentCount = 0 }));
        Assert.Throws<InvalidOperationException>(() => Catalog(new EquipmentCapabilityCatalogOptions { EquipmentCount = 10_001 }));
        Assert.Throws<InvalidOperationException>(() => Catalog(new EquipmentCapabilityCatalogOptions { EquipmentPrefix = " " }));
        Assert.Throws<InvalidOperationException>(() => Catalog(new EquipmentCapabilityCatalogOptions { DefaultActions = [] }));
        Assert.Throws<InvalidOperationException>(() => Catalog(new EquipmentCapabilityCatalogOptions { DefaultActions = ["START", "bad action"] }));

        var noActions = new EquipmentCapabilityCatalogOptions();
        var noActionsFab = new EquipmentCapabilityFabOptions();
        noActionsFab.Equipment["equipment-0"] = new EquipmentCapabilityEntryOptions();
        noActions.Fabs["FAB-01"] = noActionsFab;
        Assert.Throws<InvalidOperationException>(() => Catalog(noActions));

        var badPrecondition = new EquipmentCapabilityCatalogOptions();
        var entry = new EquipmentCapabilityEntryOptions { Actions = ["START"] };
        entry.Preconditions["STOP"] = "running";
        var badPreconditionFab = new EquipmentCapabilityFabOptions();
        badPreconditionFab.Equipment["equipment-0"] = entry;
        badPrecondition.Fabs["FAB-01"] = badPreconditionFab;
        Assert.Throws<InvalidOperationException>(() => Catalog(badPrecondition));

        var emptyPreconditionState = new EquipmentCapabilityCatalogOptions();
        var emptyEntry = new EquipmentCapabilityEntryOptions { Actions = ["STOP"] };
        emptyEntry.Preconditions["STOP"] = " ";
        var emptyFab = new EquipmentCapabilityFabOptions();
        emptyFab.Equipment["equipment-0"] = emptyEntry;
        emptyPreconditionState.Fabs["FAB-01"] = emptyFab;
        Assert.Throws<InvalidOperationException>(() => Catalog(emptyPreconditionState));
    }

    [Fact]
    public void ValidatorEnforcesCatalogActionsAndStatePreconditions()
    {
        var options = new EquipmentCapabilityCatalogOptions();
        var entry = new EquipmentCapabilityEntryOptions { Actions = ["START", "STOP"] };
        entry.Preconditions["STOP"] = "running";
        var fabOptions = new EquipmentCapabilityFabOptions();
        fabOptions.Equipment["equipment-0"] = entry;
        options.Fabs["FAB-01"] = fabOptions;
        var state = new FixedStateProvider("idle");
        var validator = new EquipmentCommandValidator(Catalog(options), state);

        Assert.True(validator.Validate(SiteId, Fab01, Request("equipment-0", "START")).IsValid);

        var preconditionFailure = validator.Validate(SiteId, Fab01, Request("equipment-0", "STOP"));
        Assert.False(preconditionFailure.IsValid);
        Assert.Equal("Command precondition not met", preconditionFailure.Title);
        Assert.Contains("running", preconditionFailure.Detail);
        Assert.Contains("idle", preconditionFailure.Detail);

        state.State = "running";
        Assert.True(validator.Validate(SiteId, Fab01, Request("equipment-0", "STOP")).IsValid);

        var unsupported = validator.Validate(SiteId, Fab01, Request("equipment-0", "PAUSE"));
        Assert.False(unsupported.IsValid);
        Assert.Equal("Unsupported action", unsupported.Title);

        var unknown = validator.Validate(SiteId, Fab01, Request("equipment-1", "START"));
        Assert.False(unknown.IsValid);
        Assert.Equal("Unknown equipment", unknown.Title);
    }

    [Fact]
    public void DefaultCatalogValidatesWithoutConsultingStateProvider()
    {
        var validator = new EquipmentCommandValidator(Catalog(new EquipmentCapabilityCatalogOptions()), new ForbiddenStateProvider());
        foreach (var equipmentId in new[] { "equipment-0", "equipment-120" })
        {
            foreach (var action in new[] { "START", "STOP", "PAUSE" })
                Assert.True(validator.Validate(SiteId, Fab02, Request(equipmentId, action, Fab02)).IsValid);
        }
        Assert.Equal("Unknown equipment", validator.Validate(SiteId, Fab02, Request("equipment-121", "START", Fab02)).Title);
        Assert.Equal("Unsupported action", validator.Validate(SiteId, Fab02, Request("equipment-0", "RESET", Fab02)).Title);
    }

    private static EquipmentCapabilityCatalog Catalog(EquipmentCapabilityCatalogOptions options) =>
        new(Options.Create(options));

    private static EquipmentCommandRequest Request(string equipmentId, string action, FabUnit? fab = null) =>
        new((fab ?? Fab01).Id.ToString("D"), equipmentId, action);

    private sealed class FixedStateProvider(string? state) : IEquipmentStateProvider
    {
        public string? State { get; set; } = state;

        public string? GetState(Guid siteId, FabUnit fab, string equipmentId) => State;
    }

    private sealed class ForbiddenStateProvider : IEquipmentStateProvider
    {
        public string? GetState(Guid siteId, FabUnit fab, string equipmentId) =>
            throw new InvalidOperationException("The default catalog must not evaluate state preconditions.");
    }
}
