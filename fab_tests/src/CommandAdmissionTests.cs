using System.Diagnostics;
using System.Globalization;
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
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Xunit;

namespace Fab.Tests;

/// <summary>
/// R4-08b/R4-09 backend coverage: per-FAB active-command admission is enforced inside the durable
/// submit transaction (explicit HTTP 429, no partial state, idempotent replay still succeeds at
/// capacity, the bound is durable across restart and per FAB) and the live SSE loop advances its
/// scan cursor for FAB-filtered empty pages so a retention trim cannot fabricate a replay-gap.
/// </summary>
public sealed class CommandAdmissionTests : IDisposable
{
    private const string Key = "command-admission-tests-development-key-0001";
    private const string Principal = "local-developer";
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(15);
    private readonly List<string> roots = [];

    public void Dispose()
    {
        foreach (var root in roots) TestDataDirectory.Delete(root);
        roots.Clear();
    }

    [Fact]
    public async Task SubmitAtActiveCapacityReturnsExplicit429AndCreatesNothing()
    {
        var root = Root();
        using var factory = Factory(root, new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxActiveCommandsPerFab = 2
        });
        using var client = Authorized(factory);
        var (siteId, fabs) = await SiteAsync(client);
        var fabId = Assert.Single(fabs);

        var first = await SubmitAcceptedAsync(client, siteId, fabId, "equipment-0", "capacity-1");
        var second = await SubmitAcceptedAsync(client, siteId, fabId, "equipment-1", "capacity-2");

        using var rejected = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-2", action = "START" }, "capacity-3");
        Assert.Equal((HttpStatusCode)429, rejected.StatusCode);
        Assert.Equal("application/problem+json", rejected.Content.Headers.ContentType!.MediaType);
        using var problem = JsonDocument.Parse(await rejected.Content.ReadAsStringAsync());
        var rootElement = problem.RootElement;
        Assert.Equal("Active command capacity exceeded", rootElement.GetProperty("title").GetString());
        Assert.Equal("ACTIVE_COMMAND_CAPACITY", rootElement.GetProperty("errorCode").GetString());
        Assert.Equal("active-command-capacity", rootElement.GetProperty("code").GetString());
        Assert.Equal(2, rootElement.GetProperty("limit").GetInt32());
        Assert.Equal(2, rootElement.GetProperty("activeCommands").GetInt32());
        var detail = rootElement.GetProperty("detail").GetString();
        Assert.False(string.IsNullOrWhiteSpace(detail));
        Assert.Contains("2", detail);
        Assert.Contains("FAB-01", detail);

        // No silent drop and no actor creation: the rejected submission left no command, journal
        // event or in-memory state behind, and the two accepted commands remain active.
        var service = factory.Services.GetRequiredService<EquipmentCommandService>();
        Assert.Equal(2, service.ReadJournal(Guid.Parse(siteId), null, fabId).Events.Length);
        using var active = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=active");
        Assert.Equal(HttpStatusCode.OK, active.StatusCode);
        using var activeDocument = JsonDocument.Parse(await active.Content.ReadAsStringAsync());
        var activeIds = activeDocument.RootElement.GetProperty("commands").EnumerateArray()
            .Select(item => item.GetProperty("commandId").GetString()!).OrderBy(id => id, StringComparer.Ordinal).ToArray();
        Assert.Equal(new[] { first, second }.OrderBy(id => id, StringComparer.Ordinal).ToArray(), activeIds);
    }

    [Fact]
    public async Task IdempotentReplayStillSucceedsAtActiveCapacity()
    {
        var root = Root();
        using var factory = Factory(root, new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxActiveCommandsPerFab = 1
        });
        using var client = Authorized(factory);
        var (siteId, fabs) = await SiteAsync(client);
        var fabId = Assert.Single(fabs);
        var body = new { fabId, equipmentId = "equipment-0", action = "START" };

        var first = await SubmitAcceptedAsync(client, siteId, fabId, "equipment-0", "capacity-replay-1");
        Assert.NotEqual("", first);

        // At capacity, replaying the accepted command creates nothing new and must still return 202.
        using var replay = await PostCommandAsync(client, siteId, body, "capacity-replay-1");
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayDocument = JsonDocument.Parse(await replay.Content.ReadAsStringAsync());
        Assert.Equal(first, replayDocument.RootElement.GetProperty("commandId").GetString());
        Assert.Equal(0, replayDocument.RootElement.GetProperty("revision").GetInt32());
        Assert.Equal(EquipmentCommandService.AcceptedOutcome, replayDocument.RootElement.GetProperty("outcome").GetString());

        // A same-key different-payload retry is still an idempotency conflict (409), decided before admission.
        using var conflict = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "STOP" }, "capacity-replay-1");
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);

        // A brand-new command is rejected at capacity even for another equipment.
        using var fresh = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-1", action = "START" }, "capacity-replay-2");
        Assert.Equal((HttpStatusCode)429, fresh.StatusCode);
    }

    [Fact]
    public async Task ActiveCapacityIsPerFabAndNotPerSite()
    {
        var root = Root();
        using var factory = Factory(root, new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxActiveCommandsPerFab = 1
        }, fabCount: 2);
        using var client = Authorized(factory);
        var (siteId, fabs) = await SiteAsync(client);
        Assert.Equal(2, fabs.Length);

        await SubmitAcceptedAsync(client, siteId, fabs[0], "equipment-0", "per-fab-1");
        // The sibling FAB owns an independent admission budget for the same Site.
        await SubmitAcceptedAsync(client, siteId, fabs[1], "equipment-0", "per-fab-2");

        using var fabOne = await PostCommandAsync(client, siteId,
            new { fabId = fabs[0], equipmentId = "equipment-1", action = "START" }, "per-fab-3");
        Assert.Equal((HttpStatusCode)429, fabOne.StatusCode);
        using var fabTwo = await PostCommandAsync(client, siteId,
            new { fabId = fabs[1], equipmentId = "equipment-1", action = "START" }, "per-fab-4");
        Assert.Equal((HttpStatusCode)429, fabTwo.StatusCode);
    }

    [Fact]
    public async Task ActiveCapacityIsReleasedWhenACommandReachesTerminal()
    {
        var root = Root();
        using var factory = Factory(root, new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromMilliseconds(500),
            SucceededDelay = TimeSpan.FromSeconds(1),
            MaxActiveCommandsPerFab = 1
        });
        using var client = Authorized(factory);
        var (siteId, fabs) = await SiteAsync(client);
        var fabId = Assert.Single(fabs);

        var first = await SubmitAcceptedAsync(client, siteId, fabId, "equipment-0", "capacity-release-1");
        using (var rejected = await PostCommandAsync(client, siteId,
                   new { fabId, equipmentId = "equipment-1", action = "START" }, "capacity-release-2"))
        {
            Assert.Equal((HttpStatusCode)429, rejected.StatusCode);
        }

        await PollUntilAsync(client, first,
            status => status.GetProperty("revision").GetInt32() >= 2, PollTimeout);
        // Terminal (revision 2) commands do not consume the active-command admission budget.
        await SubmitAcceptedAsync(client, siteId, fabId, "equipment-1", "capacity-release-3");
    }

    [Fact]
    public void RestartReenforcesDurableActiveCapacityAndStoreReplayBeatsAdmission()
    {
        var root = Root();
        var siteId = SiteDirectory.DemoSiteId;
        var fabId = SiteDirectory.CreateFab(1).Id.ToString("D");
        var options = new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxActiveCommandsPerFab = 2
        };
        var first = Service(root, options);
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, first.Submit(siteId,
            new EquipmentCommandRequest(fabId, "equipment-0", "START"), Principal, "durable-1").Status);
        Assert.Equal(EquipmentCommandSubmitStatus.Accepted, first.Submit(siteId,
            new EquipmentCommandRequest(fabId, "equipment-1", "START"), Principal, "durable-2").Status);

        var rejected = first.Submit(siteId, new EquipmentCommandRequest(fabId, "equipment-2", "START"),
            Principal, "durable-3");
        Assert.Equal(EquipmentCommandSubmitStatus.ActiveCapacityExceeded, rejected.Status);
        Assert.Null(rejected.Command);
        Assert.Equal(2, rejected.ActiveCommands);
        Assert.Equal(2, CountRows(root, "commands"));
        Assert.Equal(2, CountRows(root, "journal"));

        // The bound is durable, not an in-memory counter: a restarted service sees the same limit.
        var restarted = Service(root, options);
        var afterRestart = restarted.Submit(siteId, new EquipmentCommandRequest(fabId, "equipment-3", "START"),
            Principal, "durable-4");
        Assert.Equal(EquipmentCommandSubmitStatus.ActiveCapacityExceeded, afterRestart.Status);
        Assert.Null(afterRestart.Command);

        // Durable transaction ordering: replay/conflict is decided before the admission count, so a
        // replay of a committed command succeeds while a brand-new insert in the same transaction
        // is rejected without writing anything.
        var store = new SqliteCommandStore(TestDataDirectory.DatabasePath(root));
        var recovered = store.Recover(siteId);
        var entry = recovered.Idempotency[0];
        var record = recovered.Records.Single(candidate => candidate.CommandId == entry.CommandId);
        var replay = store.CommitSubmit(siteId, record, entry, options.MaxActiveCommandsPerFab);
        Assert.Equal(CommandStoreSubmitStatus.Replayed, replay.Status);

        var occurredAt = DateTimeOffset.UtcNow.ToString("O");
        var commandId = Guid.NewGuid().ToString("D");
        var capacity = store.CommitSubmit(siteId,
            new CommandPersistedRecord(siteId.ToString("D"), fabId, "equipment-4", "START", commandId, 0,
                EquipmentCommandService.AcceptedOutcome, occurredAt, occurredAt, null),
            new CommandIdempotencyRecord(siteId.ToString("D"), fabId, Principal, "durable-5",
                CommandRequestHash.Compute(siteId, Guid.Parse(fabId), "equipment-4", "START"), commandId,
                "{}", occurredAt),
            options.MaxActiveCommandsPerFab);
        Assert.Equal(CommandStoreSubmitStatus.CapacityExceeded, capacity.Status);
        Assert.Equal(2, capacity.ActiveCommands);
        Assert.Equal(2, CountRows(root, "commands"));
        Assert.Equal(2, CountRows(root, "journal"));
    }

    [Fact]
    public void ConstructorRejectsOutOfRangeActiveCapacityBound()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new EquipmentCommandService(
            TestDataDirectory.Store(), new SiteDirectory(), TimeProvider.System,
            new EquipmentCommandOptions { MaxActiveCommandsPerFab = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => new EquipmentCommandService(
            TestDataDirectory.Store(), new SiteDirectory(), TimeProvider.System,
            new EquipmentCommandOptions
            {
                MaxActiveCommandsPerFab = EquipmentCommandOptions.MaxActiveCommandsPerFabLimit + 1
            }));
        // Boundary values are valid and the default matches the documented value.
        Assert.Equal(64, new EquipmentCommandOptions().MaxActiveCommandsPerFab);
        var boundary = new EquipmentCommandService(TestDataDirectory.Store(), new SiteDirectory(),
            TimeProvider.System, new EquipmentCommandOptions { MaxActiveCommandsPerFab = 1 });
        Assert.Equal(1, boundary.Options.MaxActiveCommandsPerFab);
        var maximum = new EquipmentCommandService(TestDataDirectory.Store(), new SiteDirectory(),
            TimeProvider.System,
            new EquipmentCommandOptions { MaxActiveCommandsPerFab = EquipmentCommandOptions.MaxActiveCommandsPerFabLimit });
        Assert.Equal(EquipmentCommandOptions.MaxActiveCommandsPerFabLimit, maximum.Options.MaxActiveCommandsPerFab);
    }

    [Fact]
    public void ConcurrentSubmissionsCannotExceedTheDurableActiveCapacity()
    {
        var root = Root();
        var siteId = SiteDirectory.DemoSiteId;
        var fabId = SiteDirectory.CreateFab(1).Id.ToString("D");
        var options = new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromHours(1),
            SucceededDelay = TimeSpan.FromHours(2),
            MaxActiveCommandsPerFab = 3
        };
        // Independent service/store instances share only the SQLite file: the bound must hold
        // through the submit transactions, not merely through one process-wide service lock.
        var services = Enumerable.Range(0, 4).Select(_ => Service(root, options)).ToArray();
        const int count = 24;
        var statuses = new EquipmentCommandSubmitStatus[count];
        Parallel.For(0, count, index =>
        {
            statuses[index] = services[index % services.Length].Submit(siteId,
                new EquipmentCommandRequest(fabId, $"equipment-{index}", "START"),
                Principal, $"concurrent-capacity-{index}").Status;
        });
        Assert.Equal(3, statuses.Count(status => status == EquipmentCommandSubmitStatus.Accepted));
        Assert.Equal(count - 3,
            statuses.Count(status => status == EquipmentCommandSubmitStatus.ActiveCapacityExceeded));
        Assert.Equal(3, CountRows(root, "commands"));
        Assert.Equal(3, CountRows(root, "journal"));
    }

    [Fact]
    public async Task ConfigurationBindsPerFabActiveCapacityBound()
    {
        var root = Root();
        // No test-service override here: this exercises the ApiHost configuration binding.
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
        {
            host.UseEnvironment("Development");
            host.UseSetting("Fab:DevelopmentKey", Key);
            host.UseSetting("Fab:DataDirectory", root);
            host.UseSetting("Fab:EmbeddedWorker", "false");
            host.UseSetting("Fab:Commands:MaxActiveCommandsPerFab", "1");
        });
        using var client = Authorized(factory);
        _ = await SiteAsync(client);
        var service = factory.Services.GetRequiredService<EquipmentCommandService>();
        Assert.Equal(1, service.Options.MaxActiveCommandsPerFab);
    }

    [Fact]
    public async Task LiveStreamAdvancesScanCursorAcrossFabFilteredEmptyPageWithoutSpuriousGap()
    {
        var root = Root();
        using var factory = Factory(root, new EquipmentCommandOptions
        {
            // Slow enough that the live SSE loop polls the advanced Site watermark before the
            // terminal event trims the journal (the regression is a stalled scan cursor, not a
            // legitimate retention gap).
            ExecutingDelay = TimeSpan.FromMilliseconds(400),
            SucceededDelay = TimeSpan.FromMilliseconds(800),
            MaxJournalEventsPerSite = 2
        }, fabCount: 2);
        using var client = Authorized(factory);
        var (siteId, fabs) = await SiteAsync(client);
        var streamFab = fabs[0];
        var otherFab = fabs[1];

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await client.GetAsync($"/api/v1/sites/{siteId}/commands/stream?fabId={streamFab}",
            HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        // Only the sibling FAB produces events: the watched stream sees a FAB-filtered empty page
        // while the Site-level sequence advances and retention eventually trims the window.
        using (var submit = await PostCommandAsync(client, siteId,
                   new { fabId = otherFab, equipmentId = "equipment-0", action = "START" }, "empty-fab-page-1"))
        {
            Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
            var otherCommandId = await CommandIdAsync(submit);
            await PollUntilAsync(client, otherCommandId,
                status => status.GetProperty("revision").GetInt32() >= 2, PollTimeout);
        }

        // Give the loop several poll cycles under the trimmed journal (first retained sequence > 1).
        await Task.Delay(TimeSpan.FromMilliseconds(500));

        // R4-09: an empty FAB-filtered page must not emit replay-gap/dirty. Before the fix the scan
        // cursor stayed at the opening watermark, so the retention trim looked like data loss and
        // forced an unnecessary authoritative recovery.
        using var idle = new CancellationTokenSource(TimeSpan.FromMilliseconds(750));
        SseEvent? unexpected = null;
        try
        {
            unexpected = await ReadSseEventAsync(reader, idle.Token);
        }
        catch (OperationCanceledException)
        {
            // Expected: nothing was written for the watched FAB.
        }
        Assert.Null(unexpected);
    }

    private string Root()
    {
        var root = TestDataDirectory.Create();
        roots.Add(root);
        return root;
    }

    private static EquipmentCommandService Service(string root, EquipmentCommandOptions options) =>
        new(new SqliteCommandStore(TestDataDirectory.DatabasePath(root)), new SiteDirectory(),
            TimeProvider.System, options);

    private WebApplicationFactory<Program> Factory(string dataDirectory, EquipmentCommandOptions options,
        int? fabCount = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
        {
            host.UseEnvironment("Development");
            host.UseSetting("Fab:DevelopmentKey", Key);
            host.UseSetting("Fab:DataDirectory", dataDirectory);
            host.UseSetting("Fab:EmbeddedWorker", "false");
            if (fabCount is { } count)
                host.UseSetting("Fab:FabCount", count.ToString(CultureInfo.InvariantCulture));
            host.ConfigureTestServices(services =>
            {
                services.RemoveAll<EquipmentCommandService>();
                services.AddSingleton(provider => new EquipmentCommandService(
                    provider.GetRequiredService<ICommandStore>(),
                    provider.GetRequiredService<SiteDirectory>(), TimeProvider.System, options,
                    provider.GetRequiredService<IEquipmentCommandValidator>()));
            });
        });

    private static HttpClient Authorized(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }

    private static async Task<(string SiteId, string[] FabIds)> SiteAsync(HttpClient client)
    {
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        return (site.SiteId, site.Fabs.Select(fab => fab.FabId).ToArray());
    }

    private static async Task<string> SubmitAcceptedAsync(HttpClient client, string siteId, string fabId,
        string equipmentId, string idempotencyKey)
    {
        using var response = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId, action = "START" }, idempotencyKey);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        return await CommandIdAsync(response);
    }

    private static async Task<HttpResponseMessage> PostCommandAsync(HttpClient client, string siteId, object body,
        string idempotencyKey)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/sites/{siteId}/commands")
        {
            Content = JsonContent.Create(body)
        };
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(message);
    }

    private static async Task<string> CommandIdAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("commandId").GetString()!;
    }

    private static async Task<JsonElement> PollUntilAsync(HttpClient client, string commandId,
        Func<JsonElement, bool> isTerminal, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            using var response = await client.GetAsync($"/api/v1/commands/{commandId}");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (isTerminal(document.RootElement)) return document.RootElement.Clone();
            Assert.True(stopwatch.Elapsed < timeout, "The command did not reach its terminal revision within the polling budget.");
            await Task.Delay(25);
        }
    }

    private static int CountRows(string root, string table)
    {
        using var connection = new SqliteConnection($"Data Source={TestDataDirectory.DatabasePath(root)}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {table};";
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private sealed record SseEvent(string? Id, string? Event, JsonElement? Data);

    private static async Task<SseEvent?> ReadSseEventAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        string? id = null;
        string? eventName = null;
        string? data = null;
        while (true)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
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
