using System.Net;
using System.Net.Http.Json;
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
    public async Task SiteHasExactlyOneFab()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        var fab = Assert.Single(site.Fabs);
        Assert.Equal("FAB-01", fab.Code);
        Assert.Equal(64, site.TemplateHash.Length);
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
    public async Task RejectsUnknownFabAndMissingIdempotencyKey()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        var request = Request(site);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/runs", request)).StatusCode);
        var alien = request.Scenario.Fabs[0] with { FabId = Guid.NewGuid().ToString() };
        using var response = await Post(client, new CreateRunRequest(request.Scenario with { Fabs = [alien] }), "unknown-fab");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var second = request.Scenario.Fabs[0] with { FabId = Guid.NewGuid().ToString(), Code = "FAB-02" };
        using var extra = await Post(client, new CreateRunRequest(request.Scenario with { Fabs = [request.Scenario.Fabs[0], second] }), "extra-fab");
        Assert.Equal(HttpStatusCode.BadRequest, extra.StatusCode);
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

    private static CreateRunRequest Request(SiteDto site) => new(new ScenarioDefinition(
        1, site.SiteId, "INDEPENDENT", "42", "100000", "0",
        site.Fabs.Select(f => new FabScenario(f.FabId, f.Code, 3, "1000")).ToArray()));

    private static Task<HttpResponseMessage> Post(HttpClient client, CreateRunRequest request, string key)
    {
        var message = new HttpRequestMessage(HttpMethod.Post, "/api/v1/runs") { Content = JsonContent.Create(request) };
        message.Headers.Add("Idempotency-Key", key);
        return client.SendAsync(message);
    }

    private static WebApplicationFactory<Program> Factory() => new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
    {
        host.UseEnvironment("Development");
        host.UseSetting("Fab:DevelopmentKey", Key);
        host.UseSetting("Fab:DataDirectory", Path.Combine(Path.GetTempPath(), "fab-api-tests", Guid.NewGuid().ToString("N")));
    });

    private static HttpClient Authorized(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }
}
