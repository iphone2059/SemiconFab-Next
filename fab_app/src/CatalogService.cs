using System.Security.Cryptography;
using System.Text.Json;
using Fab.Contracts;

namespace Fab.Catalog;

public sealed class CatalogUnavailableException(Exception inner) : Exception("Catalog snapshot is unavailable or invalid.", inner);

/// <summary>Read-only published assets; does not own Site/Run equipment state.</summary>
public sealed class CatalogService(string directory)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> Assets = ["catalog.json", "data/semiconductor_equipment_database.json",
        "data/osat-86-ground-truth.json", "data/price_estimates.json", "data/twin_bom_costs.json",
        "twin/layout-default.json", "schema.json", "LICENSE"];
    private readonly object gate = new();
    private CatalogSnapshotDto? cached;
    private string? cachedManifestHash;

    public CatalogPageDto Query(string? domain = null, string? category = null, string? query = null)
    {
        domain = string.IsNullOrWhiteSpace(domain) ? "ALL" : domain.ToUpperInvariant();
        if (domain is not ("ALL" or "FAB" or "OSAT") || query?.Length > 200 || category?.Length > 100)
            throw new ArgumentException("Invalid catalog filter.");
        var snapshot = Load();
        var items = snapshot.Entries.Where(entry => (domain == "ALL" || entry.Domain == domain)
            && (string.IsNullOrEmpty(category) || entry.Category == category)
            && (string.IsNullOrWhiteSpace(query) || entry.Vendor.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase)
                || entry.Model.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase)
                || entry.Category.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase))).ToArray();
        var categories = snapshot.Entries.GroupBy(entry => (entry.Category, entry.Domain))
            .OrderBy(group => group.Key.Category, StringComparer.Ordinal)
            .Select(group => new CatalogCategoryDto(group.Key.Category, group.Key.Domain, group.Count())).ToArray();
        return new(snapshot.ImportId, snapshot.Entries.Length, items.Length, categories, items);
    }

    public CatalogEntryDto? Find(Guid id) => Load().Entries.FirstOrDefault(entry => Guid.Parse(entry.RecordId) == id);

    private CatalogSnapshotDto Load()
    {
        lock (gate)
        {
            try
            {
                using var pointer = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(directory, "current.json")));
                var importId = pointer.RootElement.GetProperty("importId").GetString()!;
                var manifestHash = pointer.RootElement.GetProperty("manifestSha256").GetString()!;
                if (importId.Length != 64 || importId.Any(c => !char.IsAsciiHexDigit(c)) || manifestHash.Length != 64)
                    throw new InvalidDataException("Invalid import pointer.");
                if (cached?.ImportId == importId && cachedManifestHash == manifestHash) return cached;
                var bundle = Path.Combine(directory, importId);
                var manifestBytes = File.ReadAllBytes(Path.Combine(bundle, "manifest.json"));
                VerifyHash(manifestBytes, manifestHash);
                using var document = JsonDocument.Parse(manifestBytes);
                var manifest = document.RootElement;
                if (manifest.GetProperty("importId").GetString() != importId || manifest.GetProperty("issues").GetArrayLength() != 0)
                    throw new InvalidDataException("Import is not publishable.");
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var file in manifest.GetProperty("files").EnumerateArray())
                {
                    var path = file.GetProperty("path").GetString()!;
                    if (!Assets.Contains(path) || !seen.Add(path)) throw new InvalidDataException("Unexpected asset.");
                    var raw = File.ReadAllBytes(Path.Combine(bundle, "raw", path));
                    if (raw.LongLength != file.GetProperty("bytes").GetInt64()) throw new InvalidDataException("Asset size mismatch.");
                    VerifyHash(raw, file.GetProperty("sha256").GetString()!);
                }
                if (!seen.SetEquals(Assets)) throw new InvalidDataException("Incomplete assets.");
                var snapshotBytes = File.ReadAllBytes(Path.Combine(bundle, "catalog.snapshot.json"));
                VerifyHash(snapshotBytes, manifest.GetProperty("snapshotSha256").GetString()!);
                var snapshot = JsonSerializer.Deserialize<CatalogSnapshotDto>(snapshotBytes, Json) ?? throw new InvalidDataException("Empty snapshot.");
                CatalogValidationService.Validate(snapshot, importId);
                cached = snapshot;
                cachedManifestHash = manifestHash;
                return snapshot;
            }
            catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException or NullReferenceException)
            {
                throw new CatalogUnavailableException(error);
            }
        }
    }

    private static void VerifyHash(byte[] bytes, string expected)
    {
        if (!Convert.ToHexStringLower(SHA256.HashData(bytes)).Equals(expected, StringComparison.Ordinal))
            throw new InvalidDataException("Asset hash mismatch.");
    }
}
