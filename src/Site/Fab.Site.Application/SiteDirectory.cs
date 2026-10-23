using System.Security.Cryptography;
using System.Text;
using Fab.Contracts;
using Fab.Site.Domain;

namespace Fab.Site.Application;

/// <summary>Read-only synthetic development catalog; not a published factory model.</summary>
public sealed class SiteDirectory
{
    private readonly SiteDefinition _site;

    public SiteDirectory(int fabCount = 3)
    {
        if (fabCount is < 1 or > 32) throw new ArgumentOutOfRangeException(nameof(fabCount));
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("synthetic-fifo-single-tool-v1")));
        var fabs = Enumerable.Range(1, fabCount).Select(i =>
        {
            var code = $"FAB-{i:00}";
            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"DEMO-SITE/{code}"));
            return new FabUnit(new Guid(bytes.AsSpan(0, 16)), code);
        });
        _site = new SiteDefinition(Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "DEMO-SITE", hash, fabs);
    }

    public SiteDto[] GetSites() => [new SiteDto(_site.Id.ToString(), _site.Code, _site.TemplateHash,
        _site.Fabs.Select(f => new FabDto(f.Id.ToString(), f.Code)).ToArray())];

    public void ValidateMembership(ScenarioDefinition scenario)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        if (!Guid.TryParse(scenario.SiteId, out var site) || site != _site.Id || scenario.Fabs is null)
            throw new ArgumentException("Scenario must reference the configured Site.");
        foreach (var member in scenario.Fabs)
        {
            if (member is null || !Guid.TryParse(member.FabId, out var id) ||
                !_site.Fabs.Any(f => f.Id == id && f.Code == member.Code))
                throw new ArgumentException("Scenario FAB does not belong to the configured Site catalog.");
        }
    }
}
