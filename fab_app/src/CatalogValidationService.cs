using System.Text.Json;
using Fab.Contracts;

namespace Fab.Catalog;

/// <summary>Import invariants only. Preserved legacy levels are not re-certified.</summary>
internal static class CatalogValidationService
{
    public static void Validate(CatalogSnapshotDto snapshot, string importId)
    {
        if (snapshot.ContractVersion != 1 || snapshot.ImportId != importId || snapshot.Entries is null || snapshot.Entries.Length == 0)
            throw new InvalidDataException("Unsupported or empty catalog snapshot.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in snapshot.Entries)
        {
            if (entry is null || !Guid.TryParseExact(entry.RecordId, "D", out _) || !ids.Add(entry.RecordId)
                || string.IsNullOrWhiteSpace(entry.Vendor) || string.IsNullOrWhiteSpace(entry.Model) || string.IsNullOrWhiteSpace(entry.Category)
                || entry.Domain != (entry.Category.StartsWith("osat_", StringComparison.Ordinal) ? "OSAT" : "FAB")
                || !double.IsFinite(entry.CompletenessPct) || entry.CompletenessPct is < 0 or > 100
                || entry.MissingFields is null || entry.MissingFields.Any(field => field is null)
                || entry.ConformanceLevel is not ("draft" or "L1" or "L2" or "L3")
                || entry.Record.ValueKind != JsonValueKind.Object || entry.Legacy.ValueKind != JsonValueKind.Object
                || entry.Price is { ValueKind: not JsonValueKind.Object })
                throw new InvalidDataException("Invalid catalog entry.");
            var identity = entry.Record.GetProperty("identity");
            if (entry.Record.GetProperty("record_id").GetString() != entry.RecordId
                || identity.GetProperty("vendor").GetProperty("value").GetString() != entry.Vendor
                || identity.GetProperty("model").GetProperty("value").GetString() != entry.Model
                || identity.GetProperty("category").GetProperty("value").GetString() != entry.Category)
                throw new InvalidDataException("Catalog identity mismatch.");
        }
    }
}
