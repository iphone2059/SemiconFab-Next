using System.Security.Claims;
using Fab.Site;
using Microsoft.Extensions.Hosting;

namespace Fab.Identity;

/// <summary>
/// Authorization seam for Site/FAB resource access. Real deployments replace the
/// development policy with an identity/role based policy before enabling OT control.
/// </summary>
public interface IFabAuthorization
{
    bool IsAuthorized(Guid siteId, Guid fabId, ClaimsPrincipal principal);
}

/// <summary>
/// Development-only policy: the authenticated loopback development identity may access any
/// FAB that belongs to the configured Site catalog. Unknown or foreign FABs are never
/// authorized, so callers keep answering 404 instead of leaking resource existence.
/// </summary>
public sealed class DevelopmentFabAuthorization : IFabAuthorization
{
    private readonly IHostEnvironment environment;
    private readonly SiteDirectory directory;

    public DevelopmentFabAuthorization(IHostEnvironment environment, SiteDirectory directory)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(directory);
        this.environment = environment;
        this.directory = directory;
    }

    public bool IsAuthorized(Guid siteId, Guid fabId, ClaimsPrincipal principal)
    {
        if (principal?.Identity?.IsAuthenticated != true) return false;
        if (!environment.IsDevelopment()) return false;
        return directory.TryGetFab(siteId, fabId, out _);
    }
}
