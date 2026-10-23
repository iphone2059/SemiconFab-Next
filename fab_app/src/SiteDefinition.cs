namespace Fab.Site;

public sealed record FabUnit(Guid Id, string Code);

public sealed class SiteDefinition
{
    public Guid Id { get; }
    public string Code { get; }
    public string TemplateHash { get; }
    public IReadOnlyList<FabUnit> Fabs { get; }

    public SiteDefinition(Guid id, string code, string templateHash, IEnumerable<FabUnit> fabs)
    {
        var members = fabs.ToArray();
        if (id == Guid.Empty || string.IsNullOrWhiteSpace(code) || templateHash.Length != 64 ||
            members.Length is < 1 or > 32 || members.Any(f => f.Id == Guid.Empty || string.IsNullOrWhiteSpace(f.Code)) ||
            members.Select(f => f.Id).Distinct().Count() != members.Length ||
            members.Select(f => f.Code).Distinct(StringComparer.Ordinal).Count() != members.Length)
            throw new ArgumentException("Invalid Site or FAB membership.");
        Id = id;
        Code = code;
        TemplateHash = templateHash;
        Fabs = Array.AsReadOnly(members);
    }
}
