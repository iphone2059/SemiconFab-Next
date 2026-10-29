using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Fab.App;
using Fab.Contracts;
using Fab.Site;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Xunit;
using Xunit.Sdk;

namespace Fab.Tests;

/// <summary>
/// API-level coverage for the ADR-008 recovery endpoints and for durable restart recovery over
/// HTTP: authoritative FAB command listing, journal paging with gap information, idempotency and
/// revision stability across a host restart, plus the SSE replay-gap + dirty combination (CORE-013).
/// </summary>
public sealed class CommandRecoveryApiTests : IDisposable
{
    private const string Key = "command-recovery-api-tests-development-key-0001";
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(10);
    private readonly List<string> roots = [];

    public void Dispose()
    {
        foreach (var root in roots) TestDataDirectory.Delete(root);
        roots.Clear();
    }

    [Fact]
    public async Task ListCommandsIsAuthoritativeAndFiltersByStatusAndRevision()
    {
        var root = Root();
        using var factory = Factory(root, FastOptions());
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var first = await SubmitAsync(client, siteId, fabId, "equipment-0", "list-1");
        var second = await SubmitAsync(client, siteId, fabId, "equipment-1", "list-2");
        await PollTerminalAsync(client, first);
        await PollTerminalAsync(client, second);

        using var all = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all");
        Assert.Equal(HttpStatusCode.OK, all.StatusCode);
        Assert.Equal("application/json", all.Content.Headers.ContentType!.MediaType);
        using var allDocument = JsonDocument.Parse(await all.Content.ReadAsStringAsync());
        var allRoot = allDocument.RootElement;
        var epoch = allRoot.GetProperty("epoch").GetString()!;
        Assert.True(Guid.TryParse(epoch, out _));
        var latest = allRoot.GetProperty("latestSequence").GetInt64();
        Assert.True(latest >= 6);
        var commands = allRoot.GetProperty("commands").EnumerateArray().ToArray();
        Assert.Equal(2, commands.Length);
        foreach (var command in commands)
        {
            Assert.Equal(siteId, command.GetProperty("siteId").GetString());
            Assert.Equal(fabId, command.GetProperty("fabId").GetString());
            Assert.Equal(2, command.GetProperty("revision").GetInt32());
            Assert.Equal("succeeded", command.GetProperty("outcome").GetString());
            Assert.True(command.GetProperty("terminal").GetBoolean());
            Assert.True(DateTimeOffset.TryParse(command.GetProperty("occurredAt").GetString(), out _));
        }
        Assert.Equal(new[] { first, second }.OrderBy(value => value, StringComparer.Ordinal),
            commands.Select(command => command.GetProperty("commandId").GetString()!).OrderBy(value => value, StringComparer.Ordinal));

        using var active = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=active");
        using var activeDocument = JsonDocument.Parse(await active.Content.ReadAsStringAsync());
        Assert.Empty(activeDocument.RootElement.GetProperty("commands").EnumerateArray());
        using var terminal = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=terminal");
        using var terminalDocument = JsonDocument.Parse(await terminal.Content.ReadAsStringAsync());
        Assert.Equal(2, terminalDocument.RootElement.GetProperty("commands").GetArrayLength());
        using var afterTwo = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all&afterRevision=2");
        using var afterTwoDocument = JsonDocument.Parse(await afterTwo.Content.ReadAsStringAsync());
        Assert.Empty(afterTwoDocument.RootElement.GetProperty("commands").EnumerateArray());

        using var invalidStatus = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=finished");
        Assert.Equal(HttpStatusCode.BadRequest, invalidStatus.StatusCode);
        using var invalidStatusProblem = JsonDocument.Parse(await invalidStatus.Content.ReadAsStringAsync());
        Assert.Equal("INVALID_QUERY", invalidStatusProblem.RootElement.GetProperty("errorCode").GetString());
        using var invalidRevision = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?afterRevision=-2");
        Assert.Equal(HttpStatusCode.BadRequest, invalidRevision.StatusCode);
        using var unknownFab = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{Guid.NewGuid()}/commands");
        Assert.Equal(HttpStatusCode.NotFound, unknownFab.StatusCode);
    }

    [Fact]
    public async Task CommandJournalPagePaginatesAndReportsGap()
    {
        var root = Root();
        using var factory = Factory(root, FastOptions());
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var commandId = await SubmitAsync(client, siteId, fabId, "equipment-0", "journal-page-1");
        await PollTerminalAsync(client, commandId);
        var epoch = await EpochAsync(client, siteId, fabId);

        var firstPage = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=0&limit=2");
        Assert.Equal(epoch, firstPage.GetProperty("epoch").GetString());
        Assert.False(firstPage.GetProperty("hasGap").GetBoolean());
        Assert.Equal(1, firstPage.GetProperty("firstRetainedSequence").GetInt64());
        Assert.Equal(3, firstPage.GetProperty("latestSequence").GetInt64());
        var firstEvents = firstPage.GetProperty("events").EnumerateArray().ToArray();
        Assert.Equal(new long[] { 1, 2 }, firstEvents.Select(item => item.GetProperty("sequence").GetInt64()).ToArray());
        Assert.Equal(commandId, firstEvents[0].GetProperty("commandId").GetString());
        Assert.Equal(fabId, firstEvents[0].GetProperty("fabId").GetString());
        Assert.Equal(0, firstEvents[0].GetProperty("revision").GetInt32());
        Assert.Equal("accepted", firstEvents[0].GetProperty("outcome").GetString());

        var tail = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=2&limit=10");
        Assert.False(tail.GetProperty("hasGap").GetBoolean());
        var tailEvents = tail.GetProperty("events").EnumerateArray().ToArray();
        Assert.Single(tailEvents);
        Assert.Equal(3, tailEvents[0].GetProperty("sequence").GetInt64());
        Assert.Equal(2, tailEvents[0].GetProperty("revision").GetInt32());

        var caughtUp = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=3");
        Assert.False(caughtUp.GetProperty("hasGap").GetBoolean());
        Assert.Empty(caughtUp.GetProperty("events").EnumerateArray());
        var ahead = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=99");
        Assert.True(ahead.GetProperty("hasGap").GetBoolean());

        foreach (var query in new[] { "afterSequence=-1", "limit=0", "limit=1001" })
        {
            using var invalid = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?{query}");
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
            using var problem = JsonDocument.Parse(await invalid.Content.ReadAsStringAsync());
            Assert.Equal("INVALID_QUERY", problem.RootElement.GetProperty("errorCode").GetString());
        }
    }

    [Fact]
    public async Task CommandJournalPageReportsGapAfterRetentionTrim()
    {
        var root = Root();
        using var factory = Factory(root, new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxJournalEventsPerSite = 2
        });
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        for (var index = 0; index < 3; index++)
            await SubmitAsync(client, siteId, fabId, $"equipment-{index}", $"trim-{index}");

        var page = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=0&limit=10");
        Assert.True(page.GetProperty("hasGap").GetBoolean());
        Assert.Equal(2, page.GetProperty("firstRetainedSequence").GetInt64());
        Assert.Equal(3, page.GetProperty("latestSequence").GetInt64());
        Assert.Equal(new long[] { 2, 3 }, page.GetProperty("events").EnumerateArray()
            .Select(item => item.GetProperty("sequence").GetInt64()).ToArray());
        var boundary = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=1&limit=10");
        Assert.False(boundary.GetProperty("hasGap").GetBoolean());
    }

    [Fact]
    public async Task RestartOverSameDataDirectoryRecoversCommandIdempotencyAndJournal()
    {
        var root = Root();
        string siteId;
        string fabId;
        string commandId;
        string epoch;
        long latest;
        using (var firstFactory = Factory(root, FastOptions()))
        using (var firstClient = Authorized(firstFactory))
        {
            (siteId, fabId) = await SiteAsync(firstClient);
            commandId = await SubmitAsync(firstClient, siteId, fabId, "equipment-0", "http-restart-1");
            await PollTerminalAsync(firstClient, commandId);
            epoch = await EpochAsync(firstClient, siteId, fabId);
            var page = await GetJsonAsync(firstClient, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=0");
            latest = page.GetProperty("latestSequence").GetInt64();
            using var status = await firstClient.GetAsync($"/api/v1/commands/{commandId}");
            Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        }

        using var restarted = Factory(root, FastOptions());
        using var client = Authorized(restarted);
        using var recovered = await client.GetAsync($"/api/v1/commands/{commandId}");
        Assert.Equal(HttpStatusCode.OK, recovered.StatusCode);
        using var recoveredDocument = JsonDocument.Parse(await recovered.Content.ReadAsStringAsync());
        Assert.Equal(2, recoveredDocument.RootElement.GetProperty("revision").GetInt32());
        Assert.Equal("succeeded", recoveredDocument.RootElement.GetProperty("outcome").GetString());

        using var replay = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "http-restart-1");
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayDocument = JsonDocument.Parse(await replay.Content.ReadAsStringAsync());
        Assert.Equal(commandId, replayDocument.RootElement.GetProperty("commandId").GetString());
        Assert.Equal(0, replayDocument.RootElement.GetProperty("revision").GetInt32());

        var listing = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all");
        Assert.Equal(epoch, listing.GetProperty("epoch").GetString());
        Assert.Equal(1, listing.GetProperty("commands").GetArrayLength());

        using var resumed = await OpenStreamAsync(client, siteId, fabId, $"{epoch}:1");
        Assert.Equal(HttpStatusCode.OK, resumed.StatusCode);
        await using var body = await resumed.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(body, Encoding.UTF8);
        var next = await ReadSseEventAsync(reader)
            ?? throw new XunitException("The restarted command stream ended before replaying the retained journal.");
        Assert.Null(next.Event);
        Assert.Equal(2, next.Data!.Value.GetProperty("sequence").GetInt64());
        Assert.Equal(1, next.Data!.Value.GetProperty("payload").GetProperty("revision").GetInt32());
    }

    [Fact]
    public async Task Core013RestartCursorBreakEventLossAndDuplicateIdempotencyOverHttp()
    {
        var root = Root();
        string siteId;
        string fabId;
        string commandId;
        string epoch;
        long latest;
        using (var firstFactory = Factory(root, FastOptions()))
        using (var firstClient = Authorized(firstFactory))
        {
            (siteId, fabId) = await SiteAsync(firstClient);
            commandId = await SubmitAsync(firstClient, siteId, fabId, "equipment-0", "http-core-013-1");
            await PollTerminalAsync(firstClient, commandId);
            epoch = await EpochAsync(firstClient, siteId, fabId);
            var page = await GetJsonAsync(firstClient, $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=0");
            latest = page.GetProperty("latestSequence").GetInt64();
        }
        // Event loss between host runs: the journal disappears while the authoritative records and
        // idempotency mapping survive. The next host must start a new epoch and signal the gap.
        var journalPath = Path.Combine(root, "commands", siteId, "journal", epoch + ".jsonl");
        File.WriteAllText(journalPath, "");

        using var restarted = Factory(root, FastOptions());
        using var client = Authorized(restarted);
        using var recovered = await client.GetAsync($"/api/v1/commands/{commandId}");
        Assert.Equal(HttpStatusCode.OK, recovered.StatusCode);
        using var recoveredDocument = JsonDocument.Parse(await recovered.Content.ReadAsStringAsync());
        Assert.Equal(2, recoveredDocument.RootElement.GetProperty("revision").GetInt32());

        using var replay = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "http-core-013-1");
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayDocument = JsonDocument.Parse(await replay.Content.ReadAsStringAsync());
        Assert.Equal(commandId, replayDocument.RootElement.GetProperty("commandId").GetString());
        var listing = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all");
        Assert.Equal(1, listing.GetProperty("commands").GetArrayLength());
        Assert.NotEqual(epoch, listing.GetProperty("epoch").GetString());

        using var gapped = await OpenStreamAsync(client, siteId, fabId, $"{epoch}:{latest}");
        Assert.Equal(HttpStatusCode.OK, gapped.StatusCode);
        await using var body = await gapped.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(body, Encoding.UTF8);
        var gap = await ReadSseEventAsync(reader)
            ?? throw new XunitException("The command stream ended before the replay-gap frame.");
        Assert.Equal("replay-gap", gap.Event);
        Assert.Null(gap.Id);
        var dirty = await ReadSseEventAsync(reader)
            ?? throw new XunitException("The command stream ended before the dirty frame.");
        Assert.Equal("dirty", dirty.Event);
        Assert.Null(dirty.Id);
        Assert.Equal("epoch-replaced", dirty.Data!.Value.GetProperty("reason").GetString());
        var replayed = await ReadSseEventAsync(reader)
            ?? throw new XunitException("The command stream ended before replaying retained events.");
        Assert.Null(replayed.Event);
        Assert.Equal(commandId, replayed.Data!.Value.GetProperty("payload").GetProperty("commandId").GetString());
    }

    private string Root()
    {
        var root = TestDataDirectory.Create();
        roots.Add(root);
        return root;
    }

    private static EquipmentCommandOptions FastOptions() => new()
    {
        ExecutingDelay = TimeSpan.FromMilliseconds(10),
        SucceededDelay = TimeSpan.FromMilliseconds(20)
    };

    private WebApplicationFactory<Program> Factory(string dataDirectory, EquipmentCommandOptions? commandOptions = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
        {
            host.UseEnvironment("Development");
            host.UseSetting("Fab:DevelopmentKey", Key);
            host.UseSetting("Fab:DataDirectory", dataDirectory);
            host.UseSetting("Fab:EmbeddedWorker", "false");
            if (commandOptions is not null)
            {
                host.ConfigureTestServices(services =>
                {
                    services.RemoveAll<EquipmentCommandService>();
                    services.AddSingleton(provider => new EquipmentCommandService(
                        provider.GetRequiredService<ICommandStore>(),
                        provider.GetRequiredService<SiteDirectory>(), TimeProvider.System, commandOptions,
                        provider.GetRequiredService<IEquipmentCommandValidator>()));
                });
            }
        });

    private static HttpClient Authorized(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }

    private static async Task<(string SiteId, string FabId)> SiteAsync(HttpClient client)
    {
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        return (site.SiteId, Assert.Single(site.Fabs).FabId);
    }

    private static async Task<JsonElement> GetJsonAsync(HttpClient client, string path)
    {
        using var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.Clone();
    }

    private static async Task<string> EpochAsync(HttpClient client, string siteId, string fabId)
    {
        var listing = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/commands");
        return listing.GetProperty("epoch").GetString()!;
    }

    private static async Task<string> SubmitAsync(HttpClient client, string siteId, string fabId, string equipmentId, string key)
    {
        using var response = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId, action = "START" }, key);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("commandId").GetString()!;
    }

    private static async Task<HttpResponseMessage> PostCommandAsync(HttpClient client, string siteId, object body, string idempotencyKey)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/sites/{siteId}/commands")
        {
            Content = JsonContent.Create(body)
        };
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(message);
    }

    private static async Task PollTerminalAsync(HttpClient client, string commandId)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            using var response = await client.GetAsync($"/api/v1/commands/{commandId}");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (document.RootElement.GetProperty("revision").GetInt32() >= 2) return;
            Assert.True(stopwatch.Elapsed < PollTimeout, "The command did not reach its terminal revision in time.");
            await Task.Delay(20);
        }
    }

    private static async Task<HttpResponseMessage> OpenStreamAsync(HttpClient client, string siteId, string fabId, string? lastEventId)
    {
        using var message = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/sites/{siteId}/commands/stream?fabId={fabId}");
        if (lastEventId is not null) message.Headers.TryAddWithoutValidation("Last-Event-ID", lastEventId);
        return await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead);
    }

    private sealed record SseEvent(string? Id, string? Event, JsonElement? Data);

    private static async Task<SseEvent?> ReadSseEventAsync(StreamReader reader)
    {
        string? id = null;
        string? eventName = null;
        string? data = null;
        while (true)
        {
            var line = await reader.ReadLineAsync();
            if (line is null) return id is null && eventName is null && data is null ? null : BuildSseEvent(id, eventName, data);
            if (line.Length == 0)
            {
                if (id is null && eventName is null && data is null) continue;
                return BuildSseEvent(id, eventName, data);
            }
            if (line.StartsWith("id: ", StringComparison.Ordinal)) id = line["id: ".Length..];
            else if (line.StartsWith("event: ", StringComparison.Ordinal)) eventName = line["event: ".Length..];
            else if (line.StartsWith("data: ", StringComparison.Ordinal)) data = line["data: ".Length..];
        }
    }

    private static SseEvent BuildSseEvent(string? id, string? eventName, string? data)
    {
        JsonElement? element = null;
        if (data is not null)
        {
            using var document = JsonDocument.Parse(data);
            element = document.RootElement.Clone();
        }
        return new SseEvent(id, eventName, element);
    }
}