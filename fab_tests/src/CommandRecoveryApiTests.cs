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
/// API-level coverage for the ADR-010/ADR-012 recovery endpoints: authoritative FAB command
/// listing, epoch-aware journal paging (mandatory epoch, 409 epoch-mismatch, nextAfterSequence,
/// multi-page sizes, cross-FAB sparse sequences, retention holes), restart recovery over the same
/// SQLite database, crash-after-commit replay and epoch reset authoritative reconciliation.
/// </summary>
public sealed class CommandRecoveryApiTests : IDisposable
{
    private const string Key = "command-recovery-api-tests-development-key-0001";
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(20);
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
        using var unknownFab = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{Guid.NewGuid()}/commands");
        Assert.Equal(HttpStatusCode.NotFound, unknownFab.StatusCode);
    }

    [Fact]
    public async Task JournalPageRequiresEpochAndRejectsStaleEpoch()
    {
        var root = Root();
        using var factory = Factory(root, FastOptions());
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var commandId = await SubmitAsync(client, siteId, fabId, "equipment-0", "epoch-page-1");
        await PollTerminalAsync(client, commandId);
        var epoch = await EpochAsync(client, siteId, fabId);
        var basePath = $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal";

        foreach (var query in new[] { "?afterSequence=0", "?epoch=not-a-uuid&afterSequence=0", "?epoch=&afterSequence=0" })
        {
            using var invalid = await client.GetAsync(basePath + query);
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
            Assert.Equal("application/problem+json", invalid.Content.Headers.ContentType!.MediaType);
            using var problem = JsonDocument.Parse(await invalid.Content.ReadAsStringAsync());
            Assert.Equal("journal-cursor-invalid", problem.RootElement.GetProperty("code").GetString());
        }

        var staleEpoch = Guid.NewGuid().ToString("D");
        using var stale = await client.GetAsync(basePath + $"?epoch={staleEpoch}&afterSequence=0");
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal("application/problem+json", stale.Content.Headers.ContentType!.MediaType);
        using var staleDocument = JsonDocument.Parse(await stale.Content.ReadAsStringAsync());
        var staleProblem = staleDocument.RootElement;
        Assert.Equal("journal-epoch-mismatch", staleProblem.GetProperty("code").GetString());
        Assert.Equal(epoch, staleProblem.GetProperty("currentEpoch").GetString());
        Assert.Equal(1, staleProblem.GetProperty("firstRetainedSequence").GetInt64());
        Assert.Equal(3, staleProblem.GetProperty("latestSequence").GetInt64());
        Assert.NotEqual(staleEpoch, staleProblem.GetProperty("currentEpoch").GetString());

        var page = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=0&limit=100");
        Assert.Equal(epoch, page.GetProperty("epoch").GetString());
        Assert.False(page.GetProperty("hasGap").GetBoolean());
        Assert.Equal(1, page.GetProperty("firstRetainedSequence").GetInt64());
        Assert.Equal(3, page.GetProperty("latestSequence").GetInt64());
        Assert.Equal(3, page.GetProperty("nextAfterSequence").GetInt64());
        var events = page.GetProperty("events").EnumerateArray().ToArray();
        Assert.Equal(new long[] { 1, 2, 3 }, events.Select(item => item.GetProperty("sequence").GetInt64()).ToArray());
        Assert.Equal(commandId, events[0].GetProperty("commandId").GetString());
        Assert.Equal(fabId, events[0].GetProperty("fabId").GetString());
        Assert.Equal(0, events[0].GetProperty("revision").GetInt32());
        Assert.Equal("accepted", events[0].GetProperty("outcome").GetString());
    }

    [Theory]
    [InlineData(1)]
    [InlineData(256)]
    [InlineData(257)]
    [InlineData(1000)]
    public async Task JournalPagePaginatesEveryPageSizeAcrossMultiPageWatermarks(int journalSize)
    {
        var root = Root();
        using var factory = Factory(root, LongOptions());
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        await CreateAcceptedCommandsAsync(factory, siteId, fabId, journalSize);
        var epoch = await EpochAsync(client, siteId, fabId);
        long latest = journalSize;
        var basePath = $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal";

        var page = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=0&limit=1000");
        Assert.Equal(latest, page.GetProperty("latestSequence").GetInt64());
        Assert.False(page.GetProperty("hasGap").GetBoolean());
        Assert.Equal(latest, page.GetProperty("events").GetArrayLength());
        Assert.Equal(latest, page.GetProperty("nextAfterSequence").GetInt64());
        var allEvents = page.GetProperty("events").EnumerateArray().ToArray();
        Assert.Equal(1, allEvents[0].GetProperty("sequence").GetInt64());
        Assert.Equal(latest, allEvents[^1].GetProperty("sequence").GetInt64());

        var firstPage = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=0&limit=1");
        Assert.Equal(1, firstPage.GetProperty("events").GetArrayLength());
        Assert.Equal(1, firstPage.GetProperty("nextAfterSequence").GetInt64());
        if (journalSize > 1)
        {
            // A multi-page loop with limit 256 must reach the authoritative watermark without gaps.
            var cursor = 0L;
            var applied = 0;
            var pages = 0;
            while (cursor < latest)
            {
                var pageResult = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence={cursor}&limit=256");
                Assert.False(pageResult.GetProperty("hasGap").GetBoolean());
                var pageEvents = pageResult.GetProperty("events").EnumerateArray().ToArray();
                Assert.NotEmpty(pageEvents);
                Assert.All(pageEvents, item => Assert.True(item.GetProperty("sequence").GetInt64() > cursor));
                Assert.Equal(cursor + 1, pageEvents[0].GetProperty("sequence").GetInt64());
                applied += pageEvents.Length;
                cursor = pageResult.GetProperty("nextAfterSequence").GetInt64();
                pages++;
                Assert.True(pages < 100, "The journal pagination loop did not terminate.");
            }
            Assert.Equal(latest, cursor);
            Assert.Equal(latest, applied);
        }
    }

    [Fact]
    public async Task JournalPageHandlesCrossFabSparseSequencesWithProgress()
    {
        var root = Root();
        // Explicit multi-FAB architecture coverage: the deployment default stays one FAB.
        using var factory = Factory(root, LongOptions(), fabCount: 3);
        using var client = Authorized(factory);
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        Assert.Equal(3, site.Fabs.Length);
        var siteId = site.SiteId;
        Assert.Equal(3, site.Fabs.Select(fab => fab.FabId).Distinct(StringComparer.Ordinal).Count());
        var firstFab = site.Fabs[0].FabId;
        var secondFab = site.Fabs[1].FabId;
        var service = factory.Services.GetRequiredService<EquipmentCommandService>();
        for (var index = 0; index < 20; index++)
        {
            var fabId = index % 2 == 0 ? firstFab : secondFab;
            var result = service.Submit(Guid.Parse(siteId),
                new EquipmentCommandRequest(fabId, $"equipment-{index}", "START"), "local-developer", $"sparse-{index}");
            Assert.Equal(EquipmentCommandSubmitStatus.Accepted, result.Status);
        }
        var epoch = await EpochAsync(client, siteId, firstFab);
        var basePath = $"/api/v1/sites/{siteId}/fabs/{firstFab}/command-journal";
        var page = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=0&limit=1000");
        var events = page.GetProperty("events").EnumerateArray().ToArray();
        Assert.Equal(10, events.Length);
        Assert.All(events, item => Assert.Equal(firstFab, item.GetProperty("fabId").GetString()));
        var sequences = events.Select(item => item.GetProperty("sequence").GetInt64()).ToArray();
        Assert.Equal(sequences.OrderBy(sequence => sequence), sequences);
        Assert.True(sequences.Zip(sequences.Skip(1), (left, right) => right > left).All(monotonic => monotonic));
        Assert.Equal(20, page.GetProperty("latestSequence").GetInt64());
        Assert.False(page.GetProperty("hasGap").GetBoolean());

        // A FAB-filtered page can be empty while the site watermark is ahead; it must still make
        // progress (nextAfterSequence advances to the authoritative watermark) so loops terminate.
        var cursor = 0L;
        var applied = 0;
        var pages = 0;
        while (cursor < 20)
        {
            var pageResult = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence={cursor}&limit=3");
            var pageEvents = pageResult.GetProperty("events").EnumerateArray().ToArray();
            applied += pageEvents.Length;
            var next = pageResult.GetProperty("nextAfterSequence").GetInt64();
            Assert.True(next > cursor, "nextAfterSequence must make progress for sparse FAB sequences.");
            cursor = next;
            pages++;
            Assert.True(pages < 100, "The sparse journal pagination loop did not terminate.");
        }
        Assert.Equal(10, applied);
        Assert.Equal(20, cursor);

        // The last FAB event (19) is followed only by the other FAB's event (20): a direct request
        // after it yields a legitimately empty FAB page whose cursor advances to the Site watermark.
        var emptyPage = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence={sequences[^1]}&limit=3");
        Assert.Empty(emptyPage.GetProperty("events").EnumerateArray());
        Assert.False(emptyPage.GetProperty("hasGap").GetBoolean());
        Assert.Equal(20, emptyPage.GetProperty("nextAfterSequence").GetInt64());
    }

    [Fact]
    public async Task JournalPageReportsRetentionGapAfterPrune()
    {
        var root = Root();
        using var factory = Factory(root, FastOptions(new EquipmentCommandOptions { MaxTerminalCommands = 1 }));
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var first = await SubmitAsync(client, siteId, fabId, "equipment-0", "retention-page-1");
        await PollTerminalAsync(client, first);
        var second = await SubmitAsync(client, siteId, fabId, "equipment-1", "retention-page-2");
        await PollTerminalAsync(client, second);
        var epoch = await EpochAsync(client, siteId, fabId);
        var basePath = $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal";

        var gapped = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=0&limit=100");
        Assert.True(gapped.GetProperty("hasGap").GetBoolean());
        Assert.Equal(4, gapped.GetProperty("firstRetainedSequence").GetInt64());
        Assert.Equal(6, gapped.GetProperty("latestSequence").GetInt64());
        var sequences = gapped.GetProperty("events").EnumerateArray().Select(item => item.GetProperty("sequence").GetInt64()).ToArray();
        Assert.Equal(new long[] { 4, 5, 6 }, sequences);
        Assert.Equal(6, gapped.GetProperty("nextAfterSequence").GetInt64());

        var boundary = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=3&limit=100");
        Assert.False(boundary.GetProperty("hasGap").GetBoolean());
        Assert.Equal(new long[] { 4, 5, 6 }, boundary.GetProperty("events").EnumerateArray()
            .Select(item => item.GetProperty("sequence").GetInt64()).ToArray());
        var caughtUp = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=6&limit=100");
        Assert.False(caughtUp.GetProperty("hasGap").GetBoolean());
        Assert.Empty(caughtUp.GetProperty("events").EnumerateArray());
        Assert.Equal(6, caughtUp.GetProperty("nextAfterSequence").GetInt64());
    }

    [Fact]
    public async Task JournalPageFirstPageOfEmptySiteIsNotGap()
    {
        var root = Root();
        using var factory = Factory(root, FastOptions());
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var epoch = await EpochAsync(client, siteId, fabId);
        var basePath = $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal";

        var page = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=0&limit=100");
        Assert.False(page.GetProperty("hasGap").GetBoolean());
        Assert.Empty(page.GetProperty("events").EnumerateArray());
        Assert.Equal(1, page.GetProperty("firstRetainedSequence").GetInt64());
        Assert.Equal(0, page.GetProperty("latestSequence").GetInt64());
        Assert.Equal(0, page.GetProperty("nextAfterSequence").GetInt64());
        Assert.Equal(epoch, page.GetProperty("epoch").GetString());

        // A cursor ahead of an empty Site is an explicit gap and must not fabricate a success page.
        var ahead = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=5&limit=100");
        Assert.True(ahead.GetProperty("hasGap").GetBoolean());
        Assert.Empty(ahead.GetProperty("events").EnumerateArray());
        Assert.Equal(5, ahead.GetProperty("nextAfterSequence").GetInt64());
    }

    [Fact]
    public async Task JournalPageReportsGapWhenRetainedWindowIsCompletelyEmpty()
    {
        var root = Root();
        using var factory = Factory(root, FastOptions(new EquipmentCommandOptions { TerminalTtl = TimeSpan.FromSeconds(1) }));
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var commandId = await SubmitAsync(client, siteId, fabId, "equipment-0", "empty-window-1");
        await PollTerminalAsync(client, commandId);
        var epoch = await EpochAsync(client, siteId, fabId);
        // The GET below applies TTL retention, which removes the terminal command together with its
        // three journal events: latest > 0 but the retained window is empty (first = latest + 1).
        await Task.Delay(TimeSpan.FromSeconds(2));
        var basePath = $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal";

        var page = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence=0&limit=100");
        var latest = page.GetProperty("latestSequence").GetInt64();
        Assert.Equal(3, latest);
        var firstRetained = page.GetProperty("firstRetainedSequence").GetInt64();
        Assert.Equal(latest + 1, firstRetained);
        Assert.True(page.GetProperty("hasGap").GetBoolean());
        Assert.Empty(page.GetProperty("events").EnumerateArray());
        // The scan cursor advances to the scanned Site watermark even for the empty page.
        Assert.Equal(latest, page.GetProperty("nextAfterSequence").GetInt64());

        // The exact boundary before the (now empty) retained window is still not a gap.
        var boundary = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence={firstRetained - 1}&limit=100");
        Assert.False(boundary.GetProperty("hasGap").GetBoolean());
        Assert.Empty(boundary.GetProperty("events").EnumerateArray());
        Assert.Equal(latest, boundary.GetProperty("nextAfterSequence").GetInt64());
        var caughtUp = await GetJsonAsync(client, basePath + $"?epoch={epoch}&afterSequence={latest}&limit=100");
        Assert.False(caughtUp.GetProperty("hasGap").GetBoolean());
        Assert.Equal(latest, caughtUp.GetProperty("nextAfterSequence").GetInt64());
    }

    [Fact]
    public async Task RestartOverSameSqliteDatabaseRecoversCommandIdempotencyAndJournal()
    {
        var root = Root();
        string siteId;
        string fabId;
        string commandId;
        string epoch;
        using (var firstFactory = Factory(root, FastOptions()))
        using (var firstClient = Authorized(firstFactory))
        {
            (siteId, fabId) = await SiteAsync(firstClient);
            commandId = await SubmitAsync(firstClient, siteId, fabId, "equipment-0", "http-restart-1");
            await PollTerminalAsync(firstClient, commandId);
            epoch = await EpochAsync(firstClient, siteId, fabId);
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
        Assert.Equal("accepted", replayDocument.RootElement.GetProperty("outcome").GetString());

        var page = await GetJsonAsync(client,
            $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?epoch={epoch}&afterSequence=0&limit=100");
        Assert.Equal(epoch, page.GetProperty("epoch").GetString());
        Assert.False(page.GetProperty("hasGap").GetBoolean());
        Assert.Equal(3, page.GetProperty("latestSequence").GetInt64());
        Assert.Equal(3, page.GetProperty("events").GetArrayLength());

        using var stream = await OpenStreamAsync(client, siteId, fabId, $"{epoch}:1");
        Assert.Equal(HttpStatusCode.OK, stream.StatusCode);
        await using var body = await stream.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(body, Encoding.UTF8);
        var next = await ReadSseEventAsync(reader)
            ?? throw new XunitException("The restarted command stream ended before replaying the retained journal.");
        Assert.Null(next.Event);
        Assert.Equal(2, next.Data!.Value.GetProperty("sequence").GetInt64());
        Assert.Equal(1, next.Data!.Value.GetProperty("payload").GetProperty("revision").GetInt32());
    }

    [Fact]
    public async Task DatabaseResetReplacesEpochAndForcesAuthoritativeRecovery()
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
            commandId = await SubmitAsync(firstClient, siteId, fabId, "equipment-0", "http-reset-1");
            await PollTerminalAsync(firstClient, commandId);
            epoch = await EpochAsync(firstClient, siteId, fabId);
            var page = await GetJsonAsync(firstClient,
                $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?epoch={epoch}&afterSequence=0");
            latest = page.GetProperty("latestSequence").GetInt64();
        }
        TestDataDirectory.ResetDatabase(root);

        using var restarted = Factory(root, FastOptions());
        using var client = Authorized(restarted);
        using var gone = await client.GetAsync($"/api/v1/commands/{commandId}");
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
        using var stale = await client.GetAsync(
            $"/api/v1/sites/{siteId}/fabs/{fabId}/command-journal?epoch={epoch}&afterSequence={latest}");
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        using var staleDocument = JsonDocument.Parse(await stale.Content.ReadAsStringAsync());
        Assert.Equal("journal-epoch-mismatch", staleDocument.RootElement.GetProperty("code").GetString());
        var currentEpoch = staleDocument.RootElement.GetProperty("currentEpoch").GetString();
        Assert.NotEqual(epoch, currentEpoch);

        using var gapped = await OpenStreamAsync(client, siteId, fabId, $"{epoch}:{latest}");
        Assert.Equal(HttpStatusCode.OK, gapped.StatusCode);
        await using var body = await gapped.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(body, Encoding.UTF8);
        var gap = await ReadSseEventAsync(reader)
            ?? throw new XunitException("The command stream ended before the replay-gap frame.");
        Assert.Equal("replay-gap", gap.Event);
        var dirty = await ReadSseEventAsync(reader)
            ?? throw new XunitException("The command stream ended before the dirty frame.");
        Assert.Equal("dirty", dirty.Event);
        Assert.Equal("epoch-replaced", dirty.Data!.Value.GetProperty("reason").GetString());

        using var list = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all");
        using var listDocument = JsonDocument.Parse(await list.Content.ReadAsStringAsync());
        Assert.Empty(listDocument.RootElement.GetProperty("commands").EnumerateArray());
        var replacement = await SubmitAsync(client, siteId, fabId, "equipment-0", "http-reset-2");
        Assert.NotEqual(commandId, replacement);
    }

    [Fact]
    public async Task CrashAfterCommitAndRetryOverHttpReplaysSameCommand()
    {
        var root = Root();
        var injector = new TestFaultInjector { ThrowAt = CommandStoreFaultPoints.AfterCommitBeforeResponse };
        string siteId;
        string fabId;
        using (var crashingFactory = Factory(root, FastOptions(), injector: injector))
        using (var crashingClient = Authorized(crashingFactory))
        {
            (siteId, fabId) = await SiteAsync(crashingClient);
            using var response = await PostCommandAsync(crashingClient, siteId,
                new { fabId, equipmentId = "equipment-0", action = "START" }, "http-crash-1");
            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        }
        injector.ThrowAt = null;

        using var restarted = Factory(root, FastOptions());
        using var client = Authorized(restarted);
        var listing = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all");
        var commands = listing.GetProperty("commands").EnumerateArray().ToArray();
        Assert.Single(commands);
        var committedCommandId = commands[0].GetProperty("commandId").GetString();
        using var replay = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "http-crash-1");
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayDocument = JsonDocument.Parse(await replay.Content.ReadAsStringAsync());
        Assert.Equal(committedCommandId, replayDocument.RootElement.GetProperty("commandId").GetString());
        Assert.Equal(0, replayDocument.RootElement.GetProperty("revision").GetInt32());
        Assert.Equal("accepted", replayDocument.RootElement.GetProperty("outcome").GetString());
        var afterReplay = await GetJsonAsync(client, $"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all");
        Assert.Single(afterReplay.GetProperty("commands").EnumerateArray());
    }

    [Fact]
    public async Task StoreFailureReturnsExplicitServiceUnavailable()
    {
        var root = Root();
        var inner = new SqliteCommandStore(TestDataDirectory.DatabasePath(root));
        var failing = new FailingCommandStore(inner);
        using var factory = Factory(root, FastOptions(), commandStore: failing);
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        using var response = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "store-failure-1");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
        using var problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("COMMAND_STORE_UNAVAILABLE", problem.RootElement.GetProperty("errorCode").GetString());
        // No memory-only fallback: the failed command never becomes visible.
        using var listing = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/commands?status=all");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, listing.StatusCode);
    }

    private string Root()
    {
        var root = TestDataDirectory.Create();
        roots.Add(root);
        return root;
    }

    private static EquipmentCommandOptions FastOptions(EquipmentCommandOptions? source = null) => new()
    {
        ExecutingDelay = TimeSpan.FromMilliseconds(10),
        SucceededDelay = TimeSpan.FromMilliseconds(20),
        TerminalTtl = source?.TerminalTtl ?? TimeSpan.FromMinutes(5),
        MaxTerminalCommands = source?.MaxTerminalCommands ?? 512,
        MaxJournalEventsPerSite = source?.MaxJournalEventsPerSite ?? 4096
    };

    private static EquipmentCommandOptions LongOptions() => new()
    {
        ExecutingDelay = TimeSpan.FromHours(1),
        SucceededDelay = TimeSpan.FromHours(2),
        // The pagination fixtures deliberately create hundreds of simultaneously active commands,
        // so they raise the R4-08 per-FAB admission bound; admission itself is covered by
        // CommandAdmissionTests.
        MaxActiveCommandsPerFab = EquipmentCommandOptions.MaxActiveCommandsPerFabLimit
    };

    private WebApplicationFactory<Program> Factory(string dataDirectory, EquipmentCommandOptions? commandOptions = null,
        ICommandStoreFaultInjector? injector = null, int? fabCount = null, ICommandStore? commandStore = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
        {
            host.UseEnvironment("Development");
            host.UseSetting("Fab:DevelopmentKey", Key);
            host.UseSetting("Fab:DataDirectory", dataDirectory);
            host.UseSetting("Fab:EmbeddedWorker", "false");
            if (fabCount is { } explicitFabCount)
                host.UseSetting("Fab:FabCount", explicitFabCount.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (commandOptions is not null || injector is not null || commandStore is not null)
            {
                host.ConfigureTestServices(services =>
                {
                    if (commandStore is not null)
                    {
                        services.RemoveAll<ICommandStore>();
                        services.AddSingleton(commandStore);
                    }
                    if (injector is not null)
                    {
                        services.RemoveAll<ICommandStore>();
                        services.AddSingleton<ICommandStore>(_ => new SqliteCommandStore(
                            TestDataDirectory.DatabasePath(dataDirectory), injector));
                    }
                    services.RemoveAll<EquipmentCommandService>();
                    services.AddSingleton(provider => new EquipmentCommandService(
                        provider.GetRequiredService<ICommandStore>(),
                        provider.GetRequiredService<SiteDirectory>(), TimeProvider.System,
                        commandOptions ?? new EquipmentCommandOptions(),
                        provider.GetRequiredService<IEquipmentCommandValidator>()));
                });
            }
        });

    private static async Task CreateAcceptedCommandsAsync(WebApplicationFactory<Program> factory, string siteId, string fabId, int count)
    {
        var service = factory.Services.GetRequiredService<EquipmentCommandService>();
        for (var index = 0; index < count; index++)
        {
            var result = service.Submit(Guid.Parse(siteId),
                new EquipmentCommandRequest(fabId, $"equipment-{index % 7}", "START"), "local-developer", $"bulk-{count}-{index}");
            Assert.Equal(EquipmentCommandSubmitStatus.Accepted, result.Status);
        }
        await Task.Yield();
    }

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
        // Current deployment default is one FAB (FAB-01); every recovery endpoint is FAB-scoped,
        // and the multi-FAB path is covered by the explicit Fab:FabCount=3 sparse-journal test.
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

    /// <summary>Store double whose write path always fails like an unavailable SQLite/IO store.</summary>
    private sealed class FailingCommandStore : ICommandStore
    {
        private readonly ICommandStore inner;

        public FailingCommandStore(ICommandStore inner)
        {
            this.inner = inner;
        }

        public CommandStoreRecovery Recover(Guid siteId) => inner.Recover(siteId);

        public CommandStoreSubmitResult CommitSubmit(Guid siteId, CommandPersistedRecord command,
            CommandIdempotencyRecord idempotency, int maxActiveCommandsPerFab) =>
            throw new CommandStoreException("Simulated durable store failure.");

        public CommandJournalEvent? CommitAdvance(Guid siteId, string commandId, int expectedRevision, int revision,
            string outcome, string occurredAt, string? terminalAt) =>
            throw new CommandStoreException("Simulated durable store failure.");

        public void CommitRetention(Guid siteId, CommandRetentionUpdate update) =>
            throw new CommandStoreException("Simulated durable store failure.");
    }
}
