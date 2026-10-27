using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Fab.Contracts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Fab.Tests;

public sealed class ApiTests
{
    private const string Key = "test-only-development-identity-32-characters";

    [Fact]
    public async Task UnauthorizedCannotReadSites()
    {
        using var factory = Factory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/sites")).StatusCode);
    }

    [Fact]
    public async Task SiteHasThreeDefaultFabsWithStableFab01Id()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        Assert.Equal(64, site.TemplateHash.Length);
        Assert.Equal(3, site.Fabs.Length);
        Assert.Equal(new[] { "FAB-01", "FAB-02", "FAB-03" }, site.Fabs.Select(fab => fab.Code).ToArray());
        Assert.Equal(3, site.Fabs.Select(fab => fab.FabId).Distinct(StringComparer.Ordinal).Count());

        // FAB-01 keeps the historically published Guid; FAB-02/03 are derived the same deterministic way.
        Assert.Equal(ExpectedFabId("FAB-01"), site.Fabs[0].FabId);
        Assert.Equal(ExpectedFabId("FAB-02"), site.Fabs[1].FabId);
        Assert.Equal(ExpectedFabId("FAB-03"), site.Fabs[2].FabId);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(5)]
    public async Task FabCountIsConfigurable(int fabCount)
    {
        using var factory = Factory(("Fab:FabCount", fabCount.ToString(CultureInfo.InvariantCulture)));
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        Assert.Equal(fabCount, site.Fabs.Length);
        for (var index = 0; index < fabCount; index++)
            Assert.Equal("FAB-" + (index + 1).ToString("00", CultureInfo.InvariantCulture), site.Fabs[index].Code);
    }

    [Fact]
    public async Task RunIsIdempotentAndProducesRealResults()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        var request = Request(site);
        using var first = await Post(client, request, "request-1");
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        var created = (await first.Content.ReadFromJsonAsync<RunSummary>())!;
        using var again = await Post(client, request, "request-1");
        Assert.Equal(created.RunId, (await again.Content.ReadFromJsonAsync<RunSummary>())!.RunId);
        using var conflict = await Post(client, new CreateRunRequest(request.Scenario with { MasterSeed = "43" }), "request-1");
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        RunSummary run = created;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (run.Status is not ("COMPLETED" or "FAILED"))
        {
            await Task.Delay(50, timeout.Token);
            run = (await client.GetFromJsonAsync<RunSummary>($"/api/v1/runs/{created.RunId}", timeout.Token))!;
        }
        Assert.Equal("COMPLETED", run.Status);
        var result = (await client.GetFromJsonAsync<RunResult>($"/api/v1/runs/{created.RunId}/results"))!;
        var resultFab = Assert.Single(result.Fabs);
        Assert.Equal(site.Fabs[0].FabId, resultFab.FabId);
        Assert.Equal("3", resultFab.CompletedLots);
        Assert.Equal(64, resultFab.TraceHash.Length);
        Assert.NotEmpty((await client.GetFromJsonAsync<RunSummary[]>("/api/v1/runs"))!);
        using var kpi = await client.GetAsync($"/api/v1/sites/{site.SiteId}/kpi?runId={created.RunId}");
        Assert.Equal(HttpStatusCode.OK, kpi.StatusCode);
        using var totals = System.Text.Json.JsonDocument.Parse(await kpi.Content.ReadAsStringAsync());
        Assert.Equal("3", totals.RootElement.GetProperty("completedLots").GetString());
        Assert.Equal(1, totals.RootElement.GetProperty("fabCount").GetInt32());
    }

    [Fact]
    public async Task RunSupportsArbitraryMultiFabSubset()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        // FAB-01 + FAB-03: a subset, with a deliberate gap in the catalog order.
        var request = new CreateRunRequest(new ScenarioDefinition(
            1, site.SiteId, "INDEPENDENT", "42", "100000", "0",
            new[] { site.Fabs[0], site.Fabs[2] }.Select(fab => new FabScenario(fab.FabId, fab.Code, 3, "1000")).ToArray()));
        using var response = await Post(client, request, "multi-fab");
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var created = (await response.Content.ReadFromJsonAsync<RunSummary>())!;
        Assert.Equal(2, created.Executions.Length);
        Assert.Equal(new[] { site.Fabs[0].FabId, site.Fabs[2].FabId }, created.Executions.Select(execution => execution.FabId).ToArray());

        RunSummary run = created;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (run.Status is not ("COMPLETED" or "FAILED"))
        {
            await Task.Delay(50, timeout.Token);
            run = (await client.GetFromJsonAsync<RunSummary>($"/api/v1/runs/{created.RunId}", timeout.Token))!;
        }
        Assert.Equal("COMPLETED", run.Status);
        Assert.All(run.Executions, execution => Assert.Equal("COMPLETED", execution.Status));
        var result = (await client.GetFromJsonAsync<RunResult>($"/api/v1/runs/{created.RunId}/results"))!;
        Assert.Equal(2, result.Fabs.Length);
        Assert.Equal(new[] { site.Fabs[0].FabId, site.Fabs[2].FabId }, result.Fabs.Select(fab => fab.FabId).ToArray());
        Assert.Equal("6", result.Fabs.Sum(fab => int.Parse(fab.CompletedLots, CultureInfo.InvariantCulture)).ToString(CultureInfo.InvariantCulture));

        using var kpi = await client.GetAsync($"/api/v1/sites/{site.SiteId}/kpi?runId={created.RunId}");
        Assert.Equal(HttpStatusCode.OK, kpi.StatusCode);
        using var totals = System.Text.Json.JsonDocument.Parse(await kpi.Content.ReadAsStringAsync());
        Assert.Equal("6", totals.RootElement.GetProperty("completedLots").GetString());
        Assert.Equal(2, totals.RootElement.GetProperty("fabCount").GetInt32());
    }

    [Fact]
    public async Task RejectsUnknownDuplicateAndCrossSiteFabMembers()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        var request = Request(site);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/runs", request)).StatusCode);

        var unknownFab = request.Scenario.Fabs[0] with { FabId = Guid.NewGuid().ToString() };
        using var unknown = await Post(client, new CreateRunRequest(request.Scenario with { Fabs = [unknownFab] }), "unknown-fab");
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);

        using var duplicate = await Post(client, new CreateRunRequest(request.Scenario with { Fabs = [request.Scenario.Fabs[0], request.Scenario.Fabs[0]] }), "duplicate-fab");
        Assert.Equal(HttpStatusCode.BadRequest, duplicate.StatusCode);

        var mismatchedCode = request.Scenario.Fabs[0] with { Code = site.Fabs[1].Code };
        using var mismatched = await Post(client, new CreateRunRequest(request.Scenario with { Fabs = [mismatchedCode] }), "mismatched-code");
        Assert.Equal(HttpStatusCode.BadRequest, mismatched.StatusCode);

        using var empty = await Post(client, new CreateRunRequest(request.Scenario with { Fabs = [] }), "empty-fabs");
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);

        using var crossSite = await Post(client, new CreateRunRequest(request.Scenario with { SiteId = Guid.NewGuid().ToString() }), "cross-site");
        Assert.Equal(HttpStatusCode.BadRequest, crossSite.StatusCode);
    }

    [Fact]
    public async Task MissingRunReturnsProblemDetails()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        using var response = await client.GetAsync($"/api/v1/runs/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
    }

    private static string ExpectedFabId(string code)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes("DEMO-SITE/" + code));
        return new Guid(bytes.AsSpan(0, 16)).ToString("D");
    }

    private static CreateRunRequest Request(SiteDto site) => new(new ScenarioDefinition(
        1, site.SiteId, "INDEPENDENT", "42", "100000", "0",
        new[] { site.Fabs[0] }.Select(f => new FabScenario(f.FabId, f.Code, 3, "1000")).ToArray()));

    private static Task<HttpResponseMessage> Post(HttpClient client, CreateRunRequest request, string key)
    {
        var message = new HttpRequestMessage(HttpMethod.Post, "/api/v1/runs") { Content = JsonContent.Create(request) };
        message.Headers.Add("Idempotency-Key", key);
        return client.SendAsync(message);
    }

    private static WebApplicationFactory<Program> Factory(params (string Setting, string Value)[] settings) => new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
    {
        host.UseEnvironment("Development");
        host.UseSetting("Fab:DevelopmentKey", Key);
        host.UseSetting("Fab:DataDirectory", Path.Combine(Path.GetTempPath(), "fab-api-tests", Guid.NewGuid().ToString("N")));
        foreach (var (setting, value) in settings) host.UseSetting(setting, value);
    });

    private static HttpClient Authorized(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }
}
