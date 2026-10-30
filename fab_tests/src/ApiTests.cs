using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Fab.Contracts;
using Fab.Site;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Fab.Tests;

public sealed class ApiTests
{
    private const string Key = "test-only-development-identity-32-characters";

    [Fact]
    public async Task EquipmentStatusRestAndSseShareThePersistedServerEpoch()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        var url = $"/api/v1/sites/{site.SiteId}/fabs/{site.Fabs[0].FabId}/equipment-status";
        var rest = await client.GetFromJsonAsync<System.Text.Json.JsonElement>(url);
        var epoch = rest.GetProperty("epoch").GetInt64();
        Assert.True(epoch > 0);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var response = await client.GetAsync(url + "/stream", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        response.EnsureSuccessStatusCode();
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(timeout.Token));
        while (await reader.ReadLineAsync(timeout.Token) is { } line)
        {
            if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
            using var data = System.Text.Json.JsonDocument.Parse(line[6..]);
            Assert.Equal(epoch, data.RootElement.GetProperty("epoch").GetInt64());
            return;
        }
        Assert.Fail("The equipment-status stream ended without a data frame.");
    }

    [Fact]
    public async Task UnauthorizedCannotReadSites()
    {
        using var factory = Factory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/sites")).StatusCode);
    }

    [Fact]
    public async Task SiteDefaultsToSingleFabWithStableDeterministicId()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        Assert.Equal(64, site.TemplateHash.Length);
        // Current deployment default is one FAB; the architecture supports 1..32 independent FABs.
        Assert.Equal(1, SiteDirectory.DefaultFabCount);
        var fab = Assert.Single(site.Fabs);
        Assert.Equal("FAB-01", fab.Code);
        Assert.Equal(ExpectedFabId("FAB-01"), fab.FabId);
    }

    [Fact]
    public async Task MultiFabCatalogIsExplicitlyConfigurableWithDeterministicIds()
    {
        using var factory = Factory(("Fab:FabCount", "3"));
        using var client = Authorized(factory);
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        Assert.Equal(3, site.Fabs.Length);
        Assert.Equal(new[] { "FAB-01", "FAB-02", "FAB-03" }, site.Fabs.Select(fab => fab.Code).ToArray());
        Assert.Equal(3, site.Fabs.Select(fab => fab.FabId).Distinct(StringComparer.Ordinal).Count());
        foreach (var fab in site.Fabs)
            Assert.Equal(ExpectedFabId(fab.Code), fab.FabId);
        // FAB-01 keeps its stable identity; FAB-02/03 are deterministic, not aliases.
        Assert.Equal(ExpectedFabId("FAB-01"), site.Fabs[0].FabId);
        Assert.Equal(SiteDirectory.CreateFab(2).Id.ToString("D"), site.Fabs[1].FabId);
        Assert.Equal(SiteDirectory.CreateFab(3).Id.ToString("D"), site.Fabs[2].FabId);
    }

    [Fact]
    public async Task SingleFabCountCanBeConfiguredExplicitly()
    {
        using var factory = Factory(("Fab:FabCount", "1"));
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        Assert.Equal("FAB-01", Assert.Single(site.Fabs).Code);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(33)]
    public void InvalidConfiguredFabCountIsRejected(int fabCount)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new SiteDirectory(fabCount));
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
    public async Task SingleFabRunPersistsExecutionResultsAndSiteKpi()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        // Current deployment default is one FAB; a Run scenario may select any non-empty subset of
        // the Site's FABs (multi-FAB coverage uses an explicit Fab:FabCount=3 factory).
        var fab = Assert.Single(site.Fabs);
        var request = new CreateRunRequest(new ScenarioDefinition(
            1, site.SiteId, "INDEPENDENT", "42", "100000", "0",
            [new FabScenario(fab.FabId, fab.Code, 3, "1000")]));
        using var response = await Post(client, request, "single-fab");
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var created = (await response.Content.ReadFromJsonAsync<RunSummary>())!;
        Assert.Equal(fab.FabId, Assert.Single(created.Executions).FabId);

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
        var resultFab = Assert.Single(result.Fabs);
        Assert.Equal(fab.FabId, resultFab.FabId);
        Assert.Equal("3", resultFab.CompletedLots);

        using var kpi = await client.GetAsync($"/api/v1/sites/{site.SiteId}/kpi?runId={created.RunId}");
        Assert.Equal(HttpStatusCode.OK, kpi.StatusCode);
        using var totals = System.Text.Json.JsonDocument.Parse(await kpi.Content.ReadAsStringAsync());
        Assert.Equal("3", totals.RootElement.GetProperty("completedLots").GetString());
        Assert.Equal(1, totals.RootElement.GetProperty("fabCount").GetInt32());
    }

    [Fact]
    public async Task ExplicitlyConfiguredThreeFabRunPersistsAllIndependentFabsAndAggregatesSiteKpi()
    {
        using var factory = Factory(("Fab:FabCount", "3"));
        using var client = Authorized(factory);
        var site = Assert.Single((await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites"))!);
        Assert.Equal(3, site.Fabs.Length);
        var request = new CreateRunRequest(new ScenarioDefinition(
            1, site.SiteId, "INDEPENDENT", "42", "100000", "0",
            site.Fabs.Select(fab => new FabScenario(fab.FabId, fab.Code, 3, "1000")).ToArray()));
        using var response = await Post(client, request, "three-fab");
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var created = (await response.Content.ReadFromJsonAsync<RunSummary>())!;
        Assert.Equal(3, created.Executions.Length);
        Assert.Equal(site.Fabs.Select(fab => fab.FabId).OrderBy(value => value, StringComparer.Ordinal),
            created.Executions.Select(execution => execution.FabId).OrderBy(value => value, StringComparer.Ordinal));

        RunSummary run = created;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (run.Status is not ("COMPLETED" or "FAILED"))
        {
            await Task.Delay(50, timeout.Token);
            run = (await client.GetFromJsonAsync<RunSummary>($"/api/v1/runs/{created.RunId}", timeout.Token))!;
        }
        Assert.Equal("COMPLETED", run.Status);
        var result = (await client.GetFromJsonAsync<RunResult>($"/api/v1/runs/{created.RunId}/results"))!;
        Assert.Equal(3, result.Fabs.Length);
        Assert.Equal(site.Fabs.Select(fab => fab.FabId).OrderBy(value => value, StringComparer.Ordinal),
            result.Fabs.Select(fab => fab.FabId).OrderBy(value => value, StringComparer.Ordinal));

        using var kpi = await client.GetAsync($"/api/v1/sites/{site.SiteId}/kpi?runId={created.RunId}");
        Assert.Equal(HttpStatusCode.OK, kpi.StatusCode);
        using var totals = System.Text.Json.JsonDocument.Parse(await kpi.Content.ReadAsStringAsync());
        // Site KPI aggregates every FAB execution of the Run; it is not one FAB's value.
        Assert.Equal("9", totals.RootElement.GetProperty("completedLots").GetString());
        Assert.Equal(3, totals.RootElement.GetProperty("fabCount").GetInt32());
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

        var mismatchedCode = request.Scenario.Fabs[0] with { Code = "FOREIGN-FAB" };
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
