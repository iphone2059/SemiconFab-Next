using System.Security.Cryptography;
using System.Text;
using Fab.Contracts;

namespace Fab.Site;

/// <summary>
/// Read-only synthetic development catalog for the single-FAB demo site.
/// The original SemiconFab workspace exposes one cleanroom FAB, so this
/// application deliberately does not offer FAB-02/FAB-03 or a FAB count setting.
/// </summary>
public sealed class SiteDirectory
{
    private readonly SiteDefinition _site;

    public SiteDirectory()
    {
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("synthetic-fifo-single-tool-v1")));
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes("DEMO-SITE/FAB-01"));
        var fab = new FabUnit(new Guid(bytes.AsSpan(0, 16)), "FAB-01");
        _site = new SiteDefinition(Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "DEMO-SITE", hash, [fab]);
    }

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

    public void ValidateMembership(ScenarioDefinition scenario)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        if (!Guid.TryParse(scenario.SiteId, out var site) || site != _site.Id || scenario.Fabs is not { Length: 1 })
            throw new ArgumentException("A scenario must target the configured Site with exactly one FAB.");
        var member = scenario.Fabs[0];
        if (member is null || !Guid.TryParse(member.FabId, out var id) ||
            !_site.Fabs.Any(f => f.Id == id && f.Code == member.Code))
            throw new ArgumentException("Scenario FAB does not belong to the configured single-FAB catalog.");
    }
}
