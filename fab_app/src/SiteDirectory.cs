using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Fab.Contracts;

namespace Fab.Site;

/// <summary>
/// Read-only synthetic development catalog for one demo Site. The current deployment defaults to
/// one FAB (FAB-01), while the architecture must support 1..32 independent FABs (each with its own
/// runtime, telemetry, equipment status and authorization scope). The explicit <c>Fab:FabCount</c>
/// setting selects the catalog size and must not be replaced by a single-FAB assumption.
///
/// FAB ids are derived deterministically from <c>{SiteCode}/{FabCode}</c>. FAB-01 keeps
/// the Guid it always had, so existing URLs and stored data remain stable when the FAB
/// count changes; FAB-02..FAB-32 are derived the same way and never collide (covered by
/// explicit Fab:FabCount=3+ tests).
/// </summary>
public sealed class SiteDirectory
{
    public const int MinFabCount = 1;
    public const int MaxFabCount = 32;
    public const int DefaultFabCount = 1;
    public const string DemoSiteCode = "DEMO-SITE";
    public static readonly Guid DemoSiteId = Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    private readonly SiteDefinition _site;

    public SiteDirectory() : this(DefaultFabCount)
    {
    }

    public SiteDirectory(int fabCount)
    {
        if (fabCount is < MinFabCount or > MaxFabCount)
            throw new ArgumentOutOfRangeException(nameof(fabCount), $"The development catalog supports {MinFabCount}..{MaxFabCount} FABs.");
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("synthetic-fifo-single-tool-v1")));
        var fabs = Enumerable.Range(1, fabCount).Select(CreateFab).ToArray();
        _site = new SiteDefinition(DemoSiteId, DemoSiteCode, hash, fabs);
    }

    /// <summary>Deterministically derives the FAB unit for the 1-based FAB index (FAB-01..FAB-32).</summary>
    public static FabUnit CreateFab(int index)
    {
        if (index is < MinFabCount or > MaxFabCount) throw new ArgumentOutOfRangeException(nameof(index));
        var code = "FAB-" + index.ToString("00", CultureInfo.InvariantCulture);
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{DemoSiteCode}/{code}"));
        return new FabUnit(new Guid(bytes.AsSpan(0, 16)), code);
    }

    public int FabCount => _site.Fabs.Count;

    public SiteDto[] GetSites() => [new SiteDto(_site.Id.ToString(), _site.Code, _site.TemplateHash,
        _site.Fabs.Select(f => new FabDto(f.Id.ToString(), f.Code)).ToArray())];

    /// <summary>Returns true when the id is the configured Site.</summary>
    public bool TryGetSite(Guid siteId, out SiteDefinition site)
    {
        if (siteId == _site.Id)
        {
            site = _site;
            return true;
        }
        site = null!;
        return false;
    }

    /// <summary>Returns true when the FAB id belongs to the configured Site.</summary>
    public bool TryGetFab(Guid siteId, Guid fabId, out FabUnit fab)
    {
        if (TryGetSite(siteId, out var site))
        {
            foreach (var candidate in site.Fabs)
            {
                if (candidate.Id == fabId)
                {
                    fab = candidate;
                    return true;
                }
            }
        }
        fab = null!;
        return false;
    }

    /// <summary>
    /// A scenario must target the configured Site with a non-empty, duplicate-free subset
    /// of its FABs. FAB ids from another Site or with a mismatched FAB code are rejected.
    /// </summary>
    public void ValidateMembership(ScenarioDefinition scenario)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        if (!Guid.TryParse(scenario.SiteId, out var site) || site != _site.Id)
            throw new ArgumentException("A scenario must target the configured Site.");
        if (scenario.Fabs is not { Length: > 0 and <= MaxFabCount })
            throw new ArgumentException($"A scenario requires between 1 and {MaxFabCount} FAB members.");
        var seen = new HashSet<Guid>();
        foreach (var member in scenario.Fabs)
        {
            if (member is null || !Guid.TryParse(member.FabId, out var id) || !seen.Add(id))
                throw new ArgumentException("Scenario FAB members must be unique FAB ids.");
            if (!_site.Fabs.Any(fab => fab.Id == id && fab.Code == member.Code))
                throw new ArgumentException("Scenario FAB does not belong to the configured Site catalog.");
        }
    }
}
