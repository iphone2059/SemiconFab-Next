using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Fab.App;
using Fab.Contracts;
using Fab.Identity;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Xunit;
using Xunit.Sdk;

namespace Fab.Tests;

/// <summary>
/// API-level coverage for the development equipment command simulation: authoritative
/// status after submit, 404s, request/equipment validation, FAB authorization and the
/// Idempotency-Key contract (replay, conflict, concurrent retry), plus the SSE
/// command.result stream (replay + live revision transitions).
/// </summary>
public sealed class CommandApiTests
{
    private const string Key = "command-api-tests-only-development-key-0001";
    private const string Principal = "local-developer";
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ConcurrentTimeout = TimeSpan.FromSeconds(20);

    [Fact]
    public async Task SubmitReturnsAcceptedAndGetReachesSucceeded()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);

        using var submit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "submit-status-1");
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
        using var submit = await PostCommandAsync(client, unknownSite.ToString(),
            new { fabId = Guid.NewGuid().ToString(), equipmentId = "equipment-0", action = "START" }, "unknown-site-1");
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

        using var tooLongEquipment = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = new string('e', 129), action = "START" }, "invalid-body-1");
        Assert.Equal(HttpStatusCode.BadRequest, tooLongEquipment.StatusCode);
        Assert.Equal("application/problem+json", tooLongEquipment.Content.Headers.ContentType!.MediaType);

        using var tooLongAction = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = new string('a', 65) }, "invalid-body-2");
        Assert.Equal(HttpStatusCode.BadRequest, tooLongAction.StatusCode);

        using var emptyEquipment = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "", action = "START" }, "invalid-body-3");
        Assert.Equal(HttpStatusCode.BadRequest, emptyEquipment.StatusCode);

        // A syntactically valid FAB id that does not belong to the Site is a missing resource, not a malformed body.
        using var unknownFab = await PostCommandAsync(client, siteId,
            new { fabId = Guid.NewGuid().ToString(), equipmentId = "equipment-0", action = "START" }, "invalid-body-4");
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

        using var submit = await PostCommandAsync(api, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "stream-lifecycle-1");
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

    [Fact]
    public async Task SameIdempotencyKeyReplaysExactlyOneCommand()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var key = "replay-" + Guid.NewGuid().ToString("N");
        var body = new { fabId, equipmentId = "equipment-2", action = "START" };

        using var first = await PostCommandAsync(client, siteId, body, key);
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        using var firstCreated = JsonDocument.Parse(await first.Content.ReadAsStringAsync());
        var commandId = firstCreated.RootElement.GetProperty("commandId").GetString()!;

        using var replay = await PostCommandAsync(client, siteId, body, key);
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayed = JsonDocument.Parse(await replay.Content.ReadAsStringAsync());
        Assert.Equal(commandId, replayed.RootElement.GetProperty("commandId").GetString());
        Assert.Equal(0, replayed.RootElement.GetProperty("revision").GetInt32());
        Assert.Equal("accepted", replayed.RootElement.GetProperty("outcome").GetString());
        Assert.Equal("equipment-2", replayed.RootElement.GetProperty("equipmentId").GetString());
        Assert.Equal("START", replayed.RootElement.GetProperty("action").GetString());

        using var streamClient = Authorized(factory);
        using var timeout = new CancellationTokenSource(StreamTimeout);
        var (commandIds, revisions) = await ReplayJournalAsync(streamClient, siteId, timeout.Token);
        Assert.All(commandIds, id => Assert.Equal(commandId, id));
        Assert.Equal(new[] { 0, 1, 2 }, revisions);
    }

    [Fact]
    public async Task SameIdempotencyKeyWithDifferentPayloadReturnsConflict()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var key = "conflict-" + Guid.NewGuid().ToString("N");

        using var first = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-1", action = "START" }, key);
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        using var firstCreated = JsonDocument.Parse(await first.Content.ReadAsStringAsync());
        var commandId = firstCreated.RootElement.GetProperty("commandId").GetString()!;

        using var differentAction = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-1", action = "STOP" }, key);
        Assert.Equal(HttpStatusCode.Conflict, differentAction.StatusCode);
        Assert.Equal("application/problem+json", differentAction.Content.Headers.ContentType!.MediaType);
        using var actionProblem = JsonDocument.Parse(await differentAction.Content.ReadAsStringAsync());
        Assert.Equal("IDEMPOTENCY_CONFLICT", actionProblem.RootElement.GetProperty("errorCode").GetString());

        using var differentEquipment = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-4", action = "START" }, key);
        Assert.Equal(HttpStatusCode.Conflict, differentEquipment.StatusCode);

        using var replay = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-1", action = "START" }, key);
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayed = JsonDocument.Parse(await replay.Content.ReadAsStringAsync());
        Assert.Equal(commandId, replayed.RootElement.GetProperty("commandId").GetString());
    }

    [Fact]
    public async Task ConcurrentSameIdempotencyKeyCreatesExactlyOneCommand()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var key = "concurrent-" + Guid.NewGuid().ToString("N");
        var body = new { fabId, equipmentId = "equipment-3", action = "START" };

        using var timeout = new CancellationTokenSource(ConcurrentTimeout);
        var submissions = Enumerable.Range(0, 100)
            .Select(_ => SubmitAsync(client, siteId, body, key, timeout.Token))
            .ToArray();
        var results = await Task.WhenAll(submissions);

        Assert.All(results, result => Assert.Equal(HttpStatusCode.Accepted, result.Status));
        var commandId = Assert.Single(results.Select(result => result.CommandId).Distinct());

        using var streamClient = Authorized(factory);
        using var streamTimeout = new CancellationTokenSource(StreamTimeout);
        var (commandIds, revisions) = await ReplayJournalAsync(streamClient, siteId, streamTimeout.Token);
        Assert.All(commandIds, id => Assert.Equal(commandId, id));
        Assert.Equal(new[] { 0, 1, 2 }, revisions);
    }

    [Theory]
    [InlineData("equipment-121", "START")]
    [InlineData("equipment-007", "START")]
    [InlineData("equipment-", "START")]
    [InlineData("tool-0", "START")]
    [InlineData("equipment-0", "EXPLODE")]
    [InlineData("equipment-0", "start")]
    [InlineData("equipment-0", "RESET")]
    public async Task InvalidEquipmentOrActionReturnsClearProblem(string equipmentId, string action)
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);

        using var response = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId, action }, "invalid-target-" + Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
        using var problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.False(string.IsNullOrWhiteSpace(problem.RootElement.GetProperty("title").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(problem.RootElement.GetProperty("detail").GetString()));
    }

    [Fact]
    public async Task MissingOrInvalidIdempotencyKeyReturnsBadRequest()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var body = new { fabId, equipmentId = "equipment-0", action = "START" };

        using var missing = await client.PostAsJsonAsync($"/api/v1/sites/{siteId}/commands", body);
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal("application/problem+json", missing.Content.Headers.ContentType!.MediaType);

        using var tooLong = await PostCommandAsync(client, siteId, body, new string('k', 129));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);

        Assert.False(EquipmentCommandService.TryValidateIdempotencyKey(" ", out _, out _));
        Assert.False(EquipmentCommandService.TryValidateIdempotencyKey("badkey", out _, out _));
        Assert.True(EquipmentCommandService.TryValidateIdempotencyKey("  trimmed-key  ", out var normalized, out _));
        Assert.Equal("trimmed-key", normalized);
    }

    [Fact]
    public async Task FabMismatchAndDeniedAuthorizationReturnNotFoundWithoutExistenceLeak()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);

        using var mismatch = await PostCommandAsync(client, siteId,
            new { fabId = Guid.NewGuid().ToString(), equipmentId = "equipment-0", action = "START" }, "mismatch-1");
        Assert.Equal(HttpStatusCode.NotFound, mismatch.StatusCode);
        Assert.Equal("application/problem+json", mismatch.Content.Headers.ContentType!.MediaType);

        // Same resources, but a policy that denies the caller: the API must answer 404 with no ownership leak.
        using var denyingFactory = Factory(denyFabAccess: true);
        using var denyingClient = Authorized(denyingFactory);
        var (deniedSiteId, deniedFabId) = await SiteAsync(denyingClient);
        using var denied = await PostCommandAsync(denyingClient, deniedSiteId,
            new { fabId = deniedFabId, equipmentId = "equipment-0", action = "START" }, "denied-1");
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
        Assert.Equal("application/problem+json", denied.Content.Headers.ContentType!.MediaType);

        // Seed a real command through the service, then the same GET must also be an indistinguishable 404.
        var service = denyingFactory.Services.GetRequiredService<EquipmentCommandService>();
        var seeded = service.Submit(Guid.Parse(deniedSiteId),
            new EquipmentCommandRequest(deniedFabId, "equipment-0", "START"), Principal, "seeded-key-1");
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, seeded.Status);
        using var deniedGet = await denyingClient.GetAsync($"/api/v1/commands/{seeded.Command!.CommandId}");
        Assert.Equal(HttpStatusCode.NotFound, deniedGet.StatusCode);
        Assert.Equal("application/problem+json", deniedGet.Content.Headers.ContentType!.MediaType);

        // A normally authorized client can read that same command on its own instance (sanity check of the seam's default).
        using var allowedSubmit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "allowed-1");
        Assert.Equal(HttpStatusCode.Accepted, allowedSubmit.StatusCode);
        using var allowedCreated = JsonDocument.Parse(await allowedSubmit.Content.ReadAsStringAsync());
        using var allowedGet = await client.GetAsync($"/api/v1/commands/{allowedCreated.RootElement.GetProperty("commandId").GetString()}");
        Assert.Equal(HttpStatusCode.OK, allowedGet.StatusCode);
    }

    private static async Task<(string SiteId, string FabId)> SiteAsync(HttpClient client)
    {
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        var fab = Assert.Single(site.Fabs);
        return (site.SiteId, fab.FabId);
    }

    private static async Task<HttpResponseMessage> PostCommandAsync(HttpClient client, string siteId, object body,
        string idempotencyKey, CancellationToken cancellationToken = default)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/sites/{siteId}/commands")
        {
            Content = JsonContent.Create(body)
        };
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(message, cancellationToken);
    }

    private static async Task<(HttpStatusCode Status, string CommandId)> SubmitAsync(HttpClient client, string siteId,
        object body, string idempotencyKey, CancellationToken cancellationToken)
    {
        using var response = await PostCommandAsync(client, siteId, body, idempotencyKey, cancellationToken);
        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        if (response.StatusCode != HttpStatusCode.Accepted) return (response.StatusCode, "");
        using var document = JsonDocument.Parse(content);
        return (response.StatusCode, document.RootElement.GetProperty("commandId").GetString()!);
    }

    /// <summary>Opens the command SSE stream and returns the first three journaled command.result events.</summary>
    private static async Task<(string[] CommandIds, int[] Revisions)> ReplayJournalAsync(HttpClient client, string siteId,
        CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync($"/api/v1/sites/{siteId}/commands/stream",
            HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(body, Encoding.UTF8);

        var commandIds = new List<string>();
        var revisions = new List<int>();
        while (revisions.Count < 3)
        {
            var envelope = await ReadEnvelopeAsync(reader, cancellationToken)
                ?? throw new XunitException("The command stream ended before the expected journal replay completed.");
            Assert.Equal("command.result", envelope.GetProperty("topic").GetString());
            var payload = envelope.GetProperty("payload");
            commandIds.Add(payload.GetProperty("commandId").GetString()!);
            revisions.Add(payload.GetProperty("revision").GetInt32());
        }
        return (commandIds.ToArray(), revisions.ToArray());
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

    private static WebApplicationFactory<Program> Factory(bool denyFabAccess = false) => new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
    {
        host.UseEnvironment("Development");
        host.UseSetting("Fab:DevelopmentKey", Key);
        host.UseSetting("Fab:DataDirectory", Path.Combine(Path.GetTempPath(), "fab-command-api-tests", Guid.NewGuid().ToString("N")));
        host.UseSetting("Fab:EmbeddedWorker", "false");
        if (denyFabAccess)
        {
            host.ConfigureTestServices(services =>
            {
                services.RemoveAll<IFabAuthorization>();
                services.AddSingleton<IFabAuthorization>(new DenyingFabAuthorization());
            });
        }
    });

    private static HttpClient Authorized(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }

    private sealed class DenyingFabAuthorization : IFabAuthorization
    {
        public bool IsAuthorized(Guid siteId, Guid fabId, ClaimsPrincipal principal) => false;
    }
}
