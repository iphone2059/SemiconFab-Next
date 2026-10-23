using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Fab.Identity;

public sealed class DevelopmentIdentityOptions : AuthenticationSchemeOptions
{
    public string Key { get; set; } = "";
}

/// <summary>Loopback-only development identity. Never registered in production.</summary>
public sealed class DevelopmentIdentityHandler(
    IOptionsMonitor<DevelopmentIdentityOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<DevelopmentIdentityOptions>(options, logger, encoder)
{
    public const string SchemeName = "LocalDevelopment";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (Context.Connection.RemoteIpAddress is { } address && !IPAddress.IsLoopback(address))
            return Task.FromResult(AuthenticateResult.Fail("Development identity requires a loopback connection."));
        var supplied = Request.Headers["X-Fab-Dev-Key"].ToString();
        if (Options.Key.Length < 32 || supplied.Length != Options.Key.Length ||
            !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(Options.Key)))
            return Task.FromResult(AuthenticateResult.Fail("Missing or invalid local development key."));
        var identity = new ClaimsIdentity([
            new Claim(ClaimTypes.NameIdentifier, "local-developer"),
            new Claim(ClaimTypes.Name, "本地开发用户"),
            new Claim(ClaimTypes.Role, "SimulationResearcher")], SchemeName);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }
}
