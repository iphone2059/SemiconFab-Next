using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Fab.Contracts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;
using Xunit.Sdk;

namespace Fab.Tests;

/// <summary>
/// API-level coverage for the FAB-scoped telemetry.frame SSE stream: requested-FAB payload
/// identity, camelCase envelope, numeric samples, connection independence and 404 scoping.
/// </summary>
public sealed class TelemetryApiTests
{
    private const string Key = "telemetry-api-tests-only-development-key-01";
    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task TelemetryStreamEmitsFramesForRequestedFabWithNumericSamples()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteFabAsync(client);

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/telemetry/stream",
            HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);

        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        var first = await ReadEnvelopeAsync(reader, timeout.Token)
            ?? throw new XunitException("The telemetry stream ended before the first frame.");
        var second = await ReadEnvelopeAsync(reader, timeout.Token)
            ?? throw new XunitException("The telemetry stream ended before the second frame.");

        foreach (var frame in new[] { first, second })
        {
            Assert.Equal("telemetry.frame", frame.GetProperty("topic").GetString());
            var sequence = frame.GetProperty("sequence").GetInt64();
            Assert.True(sequence > 0);
            var payload = frame.GetProperty("payload");
            Assert.Equal(fabId, payload.GetProperty("fabId").GetString());
            Assert.Equal(sequence, payload.GetProperty("sequence").GetInt64());
            Assert.True(DateTimeOffset.TryParse(payload.GetProperty("capturedAt").GetString(), out _));
            var samples = payload.GetProperty("samples");
            Assert.Equal(16, samples.GetArrayLength());
            foreach (var sample in samples.EnumerateArray())
            {
                Assert.StartsWith("equipment-", sample.GetProperty("entityId").GetString());
                var values = sample.GetProperty("values");
                var state = values.GetProperty("state");
                Assert.Equal(JsonValueKind.Number, state.ValueKind);
                Assert.InRange(state.GetInt32(), 0, 3);
                var utilization = values.GetProperty("utilization");
                Assert.Equal(JsonValueKind.Number, utilization.ValueKind);
                Assert.InRange(utilization.GetDouble(), 0d, 1d);
            }
        }

        Assert.True(second.GetProperty("payload").GetProperty("sequence").GetInt64()
                > first.GetProperty("payload").GetProperty("sequence").GetInt64(),
            "Each connection must increment its telemetry frame sequence.");
    }

    [Fact]
    public async Task SingleFabStreamsKeepIndependentConnectionSequences()
    {
        using var factory = Factory();
        using var clientA = Authorized(factory);
        using var clientB = Authorized(factory);
        var site = await SiteAsync(clientA);
        // Current deployment default is one FAB; multi-FAB catalogs are explicit via Fab:FabCount.
        var fabId = Assert.Single(site.Fabs).FabId;
        using var timeout = new CancellationTokenSource(StreamTimeout);

        using var responseA = await clientA.GetAsync($"/api/v1/sites/{site.SiteId}/fabs/{fabId}/telemetry/stream",
            HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, responseA.StatusCode);
        await using var bodyA = await responseA.Content.ReadAsStreamAsync(timeout.Token);
        using var readerA = new StreamReader(bodyA, Encoding.UTF8);
        var frameA = await ReadEnvelopeAsync(readerA, timeout.Token)
            ?? throw new XunitException("The first connection ended before its first frame.");
        var nextA = await ReadEnvelopeAsync(readerA, timeout.Token)
            ?? throw new XunitException("The first connection ended before its second frame.");

        using var responseB = await clientB.GetAsync($"/api/v1/sites/{site.SiteId}/fabs/{fabId}/telemetry/stream",
            HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, responseB.StatusCode);
        await using var bodyB = await responseB.Content.ReadAsStreamAsync(timeout.Token);
        using var readerB = new StreamReader(bodyB, Encoding.UTF8);
        var frameB = await ReadEnvelopeAsync(readerB, timeout.Token)
            ?? throw new XunitException("The second connection ended before its first frame.");

        foreach (var frame in new[] { frameA, nextA, frameB })
            Assert.Equal(fabId, frame.GetProperty("payload").GetProperty("fabId").GetString());
        Assert.Equal(1, frameA.GetProperty("payload").GetProperty("sequence").GetInt64());
        Assert.Equal(2, nextA.GetProperty("payload").GetProperty("sequence").GetInt64());
        Assert.Equal(1, frameB.GetProperty("payload").GetProperty("sequence").GetInt64());
    }

    [Theory]
    [InlineData("site")]
    [InlineData("fab")]
    [InlineData("legacy-site-endpoint")]
    public async Task InvalidScopeTelemetryStreamReturnsNotFound(string scope)
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var site = await SiteAsync(client);
        var url = scope switch
        {
            "site" => $"/api/v1/sites/{Guid.NewGuid()}/fabs/{site.Fabs[0].FabId}/telemetry/stream",
            "fab" => $"/api/v1/sites/{site.SiteId}/fabs/{Guid.NewGuid()}/telemetry/stream",
            _ => $"/api/v1/sites/{site.SiteId}/telemetry/stream"
        };
        using var response = await client.GetAsync(url);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        // Known Site/FAB failures are problem+json; the removed legacy endpoint is a plain routing 404.
        if (scope != "legacy-site-endpoint")
            Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
    }

    private static async Task<SiteDto> SiteAsync(HttpClient client)
    {
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        return Assert.Single(sites!);
    }

    private static async Task<(string SiteId, string FabId)> SiteFabAsync(HttpClient client)
    {
        var site = await SiteAsync(client);
        return (site.SiteId, Assert.Single(site.Fabs).FabId);
    }

    private static async Task<JsonElement?> ReadEnvelopeAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        while (true)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null) return null;
            // SSE frames from this API contain exactly one "data: <json>" field; ignore any other field/comment line.
            if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
            using var document = JsonDocument.Parse(line["data: ".Length..]);
            return document.RootElement.Clone();
        }
    }

    private static WebApplicationFactory<Program> Factory() => new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
    {
        host.UseEnvironment("Development");
        host.UseSetting("Fab:DevelopmentKey", Key);
        host.UseSetting("Fab:DataDirectory", Path.Combine(Path.GetTempPath(), "fab-telemetry-api-tests", Guid.NewGuid().ToString("N")));
        host.UseSetting("Fab:EmbeddedWorker", "false");
    });

    private static HttpClient Authorized(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }
}
