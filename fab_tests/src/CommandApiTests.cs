using System.Diagnostics;
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
/// API-level coverage for the development equipment command simulation:
/// authoritative status after submit, 404s, request validation, and the SSE
/// command.result stream (replay + live revision transitions).
/// </summary>
public sealed class CommandApiTests
{
    private const string Key = "command-api-tests-only-development-key-0001";
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task SubmitReturnsAcceptedAndGetReachesSucceeded()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);

        using var submit = await client.PostAsJsonAsync($"/api/v1/sites/{siteId}/commands",
            new { fabId, equipmentId = "equipment-0", action = "START" });
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        using var created = JsonDocument.Parse(await submit.Content.ReadAsStringAsync());
        var root = created.RootElement;
        Assert.Equal(siteId, root.GetProperty("siteId").GetString());
        Assert.Equal(fabId, root.GetProperty("fabId").GetString());
        Assert.Equal("equipment-0", root.GetProperty("equipmentId").GetString());
        Assert.Equal("START", root.GetProperty("action").GetString());
        var commandId = root.GetProperty("commandId").GetString();
        Assert.True(Guid.TryParse(commandId, out _));
        Assert.Equal(0, root.GetProperty("revision").GetInt32());
        Assert.Equal("accepted", root.GetProperty("outcome").GetString());
        Assert.True(DateTimeOffset.TryParse(root.GetProperty("occurredAt").GetString(), out _));

        var final = await PollUntilAsync(client, commandId!,
            status => status.GetProperty("revision").GetInt32() == 2, PollTimeout);
        Assert.Equal("succeeded", final.GetProperty("outcome").GetString());
        Assert.Equal(siteId, final.GetProperty("siteId").GetString());
        Assert.Equal(fabId, final.GetProperty("fabId").GetString());
        Assert.Equal("equipment-0", final.GetProperty("equipmentId").GetString());
        Assert.Equal("START", final.GetProperty("action").GetString());
        Assert.Equal(commandId, final.GetProperty("commandId").GetString());
    }

    [Fact]
    public async Task UnknownCommandAndUnknownSiteReturnNotFound()
    {
        using var factory = Factory();
        using var client = Authorized(factory);

        using var missing = await client.GetAsync($"/api/v1/commands/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("application/problem+json", missing.Content.Headers.ContentType!.MediaType);

        var unknownSite = Guid.NewGuid();
        using var submit = await client.PostAsJsonAsync($"/api/v1/sites/{unknownSite}/commands",
            new { fabId = Guid.NewGuid().ToString(), equipmentId = "equipment-0", action = "START" });
        Assert.Equal(HttpStatusCode.NotFound, submit.StatusCode);

        using var stream = await client.GetAsync($"/api/v1/sites/{unknownSite}/commands/stream");
        Assert.Equal(HttpStatusCode.NotFound, stream.StatusCode);
        Assert.Equal("application/problem+json", stream.Content.Headers.ContentType!.MediaType);
    }

    [Fact]
    public async Task InvalidBodyAndUnknownFabMembershipAreRejected()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var url = $"/api/v1/sites/{siteId}/commands";

        using var tooLongEquipment = await client.PostAsJsonAsync(url,
            new { fabId, equipmentId = new string('e', 129), action = "START" });
        Assert.Equal(HttpStatusCode.BadRequest, tooLongEquipment.StatusCode);
        Assert.Equal("application/problem+json", tooLongEquipment.Content.Headers.ContentType!.MediaType);

        using var tooLongAction = await client.PostAsJsonAsync(url,
            new { fabId, equipmentId = "equipment-0", action = new string('a', 65) });
        Assert.Equal(HttpStatusCode.BadRequest, tooLongAction.StatusCode);

        using var emptyEquipment = await client.PostAsJsonAsync(url,
            new { fabId, equipmentId = "", action = "START" });
        Assert.Equal(HttpStatusCode.BadRequest, emptyEquipment.StatusCode);

        // A syntactically valid FAB id that does not belong to the Site is a missing resource, not a malformed body.
        using var unknownFab = await client.PostAsJsonAsync(url,
            new { fabId = Guid.NewGuid().ToString(), equipmentId = "equipment-0", action = "START" });
        Assert.Equal(HttpStatusCode.NotFound, unknownFab.StatusCode);
    }

    [Fact]
    public async Task CommandStreamDeliversAcceptedExecutingAndSucceeded()
    {
        using var factory = Factory();
        using var api = Authorized(factory);
        using var streamClient = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(api);

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await streamClient.GetAsync($"/api/v1/sites/{siteId}/commands/stream",
            HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        Assert.Contains("no-cache", response.Headers.CacheControl!.ToString(), StringComparison.OrdinalIgnoreCase);

        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        using var submit = await api.PostAsJsonAsync($"/api/v1/sites/{siteId}/commands",
            new { fabId, equipmentId = "equipment-0", action = "START" });
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        using var created = JsonDocument.Parse(await submit.Content.ReadAsStringAsync());
        var commandId = created.RootElement.GetProperty("commandId").GetString()!;

        var outcomes = new List<string>();
        var revisions = new List<int>();
        var sequences = new List<long>();
        while (outcomes.Count < 3)
        {
            var envelope = await ReadEnvelopeAsync(reader, timeout.Token)
                ?? throw new XunitException("The command stream ended before all lifecycle events arrived.");
            Assert.Equal("command.result", envelope.GetProperty("topic").GetString());
            var payload = envelope.GetProperty("payload");
            if (payload.GetProperty("commandId").GetString() != commandId) continue;
            outcomes.Add(payload.GetProperty("outcome").GetString()!);
            revisions.Add(payload.GetProperty("revision").GetInt32());
            sequences.Add(envelope.GetProperty("sequence").GetInt64());
            Assert.Equal(fabId, payload.GetProperty("fabId").GetString());
            Assert.True(DateTimeOffset.TryParse(payload.GetProperty("occurredAt").GetString(), out _));
        }

        Assert.Equal(new[] { "accepted", "executing", "succeeded" }, outcomes);
        Assert.Equal(new[] { 0, 1, 2 }, revisions);
        Assert.True(sequences.Zip(sequences.Skip(1), (previous, next) => next > previous).All(monotonic => monotonic),
            "Command stream sequences must be strictly increasing for one Site.");
    }

    private static async Task<(string SiteId, string FabId)> SiteAsync(HttpClient client)
    {
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        var fab = Assert.Single(site.Fabs);
        return (site.SiteId, fab.FabId);
    }

    private static async Task<JsonElement> PollUntilAsync(HttpClient client, string commandId,
        Func<JsonElement, bool> isTerminal, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            using var response = await client.GetAsync($"/api/v1/commands/{commandId}");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (isTerminal(document.RootElement)) return document.RootElement.Clone();
            Assert.True(stopwatch.Elapsed < timeout, "The command did not reach its terminal revision within the polling budget.");
            await Task.Delay(50);
        }
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
        host.UseSetting("Fab:DataDirectory", Path.Combine(Path.GetTempPath(), "fab-command-api-tests", Guid.NewGuid().ToString("N")));
        host.UseSetting("Fab:EmbeddedWorker", "false");
    });

    private static HttpClient Authorized(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }
}
