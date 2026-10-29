using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Fab.App;
using Fab.Contracts;
using Fab.Identity;
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

        using var stream = await client.GetAsync($"/api/v1/sites/{unknownSite}/commands/stream?fabId={Guid.NewGuid()}");
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
        using var response = await streamClient.GetAsync($"/api/v1/sites/{siteId}/commands/stream?fabId={fabId}",
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
        var (commandIds, revisions) = await ReplayJournalAsync(streamClient, siteId, fabId, timeout.Token);
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
        var (commandIds, revisions) = await ReplayJournalAsync(streamClient, siteId, fabId, streamTimeout.Token);
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
        Assert.Equal("INVALID_COMMAND", problem.RootElement.GetProperty("errorCode").GetString());
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

    [Fact]
    public async Task CommandStreamEmitsCursorIdsAndUnchangedEnvelope()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        using var submit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "cursor-ids-1");
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var commandId = await CommandIdAsync(submit);

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await OpenCommandStreamAsync(client, siteId, fabId, lastEventId: null, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        var events = new List<SseEvent>();
        while (events.Count < 3)
        {
            var sse = await ReadSseEventAsync(reader, timeout.Token)
                ?? throw new XunitException("The command stream ended before the journaled lifecycle was replayed.");
            if (sse.Data is null) continue;
            events.Add(sse);
        }

        Guid? epoch = null;
        var previousSequence = 0L;
        foreach (var sse in events)
        {
            Assert.NotNull(sse.Id);
            Assert.True(EquipmentCommandService.TryParseLastEventId(sse.Id, out var eventEpoch, out var eventSequence));
            epoch ??= eventEpoch;
            Assert.Equal(epoch.Value, eventEpoch);
            var data = sse.Data!.Value;
            Assert.Equal("command.result", data.GetProperty("topic").GetString());
            Assert.Equal(eventSequence, data.GetProperty("sequence").GetInt64());
            Assert.True(eventSequence > previousSequence, "SSE id sequences must increase.");
            previousSequence = eventSequence;
            var payload = data.GetProperty("payload");
            Assert.Equal(commandId, payload.GetProperty("commandId").GetString());
            Assert.Equal(5, payload.EnumerateObject().Count());
        }

        Assert.Equal(new[] { 0, 1, 2 },
            events.Select(sse => sse.Data!.Value.GetProperty("payload").GetProperty("revision").GetInt32()).ToArray());
    }

    [Fact]
    public async Task CommandStreamResumesFromLastEventIdWithoutGap()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        using var submit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "cursor-resume-1");
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var commandId = await CommandIdAsync(submit);

        using var timeout = new CancellationTokenSource(StreamTimeout);
        string resumeFrom;
        using (var firstResponse = await OpenCommandStreamAsync(client, siteId, fabId, lastEventId: null, timeout.Token))
        {
            Assert.Equal(HttpStatusCode.OK, firstResponse.StatusCode);
            await using var firstBody = await firstResponse.Content.ReadAsStreamAsync(timeout.Token);
            using var firstReader = new StreamReader(firstBody, Encoding.UTF8);
            var first = await ReadSseEventAsync(firstReader, timeout.Token)
                ?? throw new XunitException("The command stream ended before the first event.");
            Assert.Null(first.Event);
            Assert.NotNull(first.Id);
            resumeFrom = first.Id!;
        }

        using var resumed = await OpenCommandStreamAsync(client, siteId, fabId, resumeFrom, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, resumed.StatusCode);
        await using var resumedBody = await resumed.Content.ReadAsStreamAsync(timeout.Token);
        using var resumedReader = new StreamReader(resumedBody, Encoding.UTF8);
        var next = await ReadSseEventAsync(resumedReader, timeout.Token)
            ?? throw new XunitException("The resumed command stream ended before the next event.");
        Assert.Null(next.Event); // a valid cursor resumes without a replay-gap signal
        Assert.NotNull(next.Data);
        var payload = next.Data!.Value.GetProperty("payload");
        Assert.Equal(commandId, payload.GetProperty("commandId").GetString());
        Assert.Equal(1, payload.GetProperty("revision").GetInt32());
        Assert.Equal("executing", payload.GetProperty("outcome").GetString());
        Assert.True(EquipmentCommandService.TryParseLastEventId(next.Id, out _, out var nextSequence) && nextSequence > 1);
    }

    [Fact]
    public async Task CommandStreamSignalsReplayGapForForeignEpoch()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        using var submit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "gap-epoch-1");
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var commandId = await CommandIdAsync(submit);
        var foreignEpoch = Guid.NewGuid().ToString("D");
        var lastEventId = foreignEpoch + ":1";

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await OpenCommandStreamAsync(client, siteId, fabId, lastEventId, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        var gap = await ReadSseEventAsync(reader, timeout.Token)
            ?? throw new XunitException("The command stream ended before the replay-gap signal.");
        Assert.Equal("replay-gap", gap.Event);
        Assert.Null(gap.Id); // the control signal is not a journaled event
        Assert.NotNull(gap.Data);
        var gapData = gap.Data!.Value;
        Assert.Equal("command.result", gapData.GetProperty("topic").GetString());
        Assert.True(gapData.GetProperty("replayGap").GetBoolean());
        Assert.NotEqual(foreignEpoch, gapData.GetProperty("epoch").GetString());
        Assert.Equal(lastEventId, gapData.GetProperty("requestedLastEventId").GetString());
        var firstRetained = gapData.GetProperty("firstRetainedSequence").GetInt64();
        var latest = gapData.GetProperty("latestSequence").GetInt64();
        Assert.True(firstRetained >= 1);
        Assert.True(latest >= firstRetained);
        Assert.True(DateTimeOffset.TryParse(gapData.GetProperty("occurredAt").GetString(), out _));

        // A replaced epoch may have lost events, so the stream adds a dirty control frame that
        // requires the client to reconcile authoritative command state.
        var dirty = await ReadSseEventAsync(reader, timeout.Token)
            ?? throw new XunitException("The command stream ended before the epoch-replaced dirty signal.");
        Assert.Equal("dirty", dirty.Event);
        Assert.Null(dirty.Id);
        Assert.NotNull(dirty.Data);
        var dirtyData = dirty.Data!.Value;
        Assert.Equal("epoch-replaced", dirtyData.GetProperty("reason").GetString());
        Assert.Equal(0, dirtyData.GetProperty("droppedCount").GetInt64());
        Assert.Equal(gapData.GetProperty("epoch").GetString(), dirtyData.GetProperty("epoch").GetString());
        Assert.True(DateTimeOffset.TryParse(dirtyData.GetProperty("occurredAt").GetString(), out _));

        var replayed = await ReadSseEventAsync(reader, timeout.Token)
            ?? throw new XunitException("The command stream ended before replaying retained events after the gap.");
        Assert.Null(replayed.Event);
        Assert.Equal(commandId, replayed.Data!.Value.GetProperty("payload").GetProperty("commandId").GetString());
    }

    [Fact]
    public async Task RetentionPrunesTerminalCommandsIntoClean404AndFreshCommand()
    {
        using var factory = Factory(commandOptions: new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromMilliseconds(20),
            SucceededDelay = TimeSpan.FromMilliseconds(40),
            TerminalTtl = TimeSpan.FromMinutes(10),
            MaxTerminalCommands = 1
        });
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        const string replayKey = "retention-replay-1";
        var firstBody = new { fabId, equipmentId = "equipment-0", action = "START" };

        using var firstSubmit = await PostCommandAsync(client, siteId, firstBody, replayKey);
        Assert.Equal(HttpStatusCode.Accepted, firstSubmit.StatusCode);
        var firstCommandId = await CommandIdAsync(firstSubmit);
        await PollUntilAsync(client, firstCommandId, status => status.GetProperty("revision").GetInt32() == 2, PollTimeout);

        using var secondSubmit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-1", action = "START" }, "retention-second-1");
        Assert.Equal(HttpStatusCode.Accepted, secondSubmit.StatusCode);
        var secondCommandId = await CommandIdAsync(secondSubmit);
        await PollUntilAsync(client, secondCommandId, status => status.GetProperty("revision").GetInt32() == 2, PollTimeout);

        // The second terminal command pushes the terminal count past the configured maximum: the oldest is pruned.
        using var pruned = await client.GetAsync($"/api/v1/commands/{firstCommandId}");
        Assert.Equal(HttpStatusCode.NotFound, pruned.StatusCode);
        Assert.Equal("application/problem+json", pruned.Content.Headers.ContentType!.MediaType);
        using var retained = await client.GetAsync($"/api/v1/commands/{secondCommandId}");
        Assert.Equal(HttpStatusCode.OK, retained.StatusCode);

        // Replaying the pruned command's idempotency key creates a fresh command; it never resurrects a dead id.
        using var replay = await PostCommandAsync(client, siteId, firstBody, replayKey);
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        Assert.NotEqual(firstCommandId, await CommandIdAsync(replay));
    }

    [Fact]
    public async Task ConfiguredCapabilityCatalogRestrictsActionsAndEquipmentPerFab()
    {
        using var factory = Factory(capabilitySettings:
        [
            ("Fab:EquipmentCapabilities:Fabs:FAB-01:Equipment:equipment-0:Actions:0", "START")
        ]);
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);

        using var unsupported = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "STOP" }, "capability-action-1");
        Assert.Equal(HttpStatusCode.BadRequest, unsupported.StatusCode);
        Assert.Equal("application/problem+json", unsupported.Content.Headers.ContentType!.MediaType);
        using var unsupportedProblem = JsonDocument.Parse(await unsupported.Content.ReadAsStringAsync());
        Assert.Equal("Unsupported action", unsupportedProblem.RootElement.GetProperty("title").GetString());
        Assert.Equal("INVALID_COMMAND", unsupportedProblem.RootElement.GetProperty("errorCode").GetString());

        using var unknown = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-42", action = "START" }, "capability-unknown-1");
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        using var unknownProblem = JsonDocument.Parse(await unknown.Content.ReadAsStringAsync());
        Assert.Equal("Unknown equipment", unknownProblem.RootElement.GetProperty("title").GetString());

        // The explicitly configured FAB accepts only its declared action for its declared equipment.
        using var allowed = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "capability-allowed-1");
        Assert.Equal(HttpStatusCode.Accepted, allowed.StatusCode);
    }

    [Fact]
    public async Task UnmatchedCapabilityConfigurationLeavesSingleFabDefaultActionsAvailable()
    {
        using var factory = Factory(capabilitySettings:
        [
            ("Fab:EquipmentCapabilities:Fabs:FOREIGN-FAB:Equipment:equipment-0:Actions:0", "START")
        ]);
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        using var allowed = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-42", action = "STOP" }, "capability-fallback-1");
        Assert.Equal(HttpStatusCode.Accepted, allowed.StatusCode);
    }

    [Fact]
    public async Task ConfiguredCapabilityPreconditionFailureReturnsInvalidCommand()
    {
        using var factory = Factory(
            capabilitySettings:
            [
                ("Fab:EquipmentCapabilities:Fabs:FAB-01:Equipment:equipment-0:Actions:0", "START"),
                ("Fab:EquipmentCapabilities:Fabs:FAB-01:Equipment:equipment-0:Actions:1", "STOP"),
                ("Fab:EquipmentCapabilities:Fabs:FAB-01:Equipment:equipment-0:Preconditions:STOP", "running")
            ],
            stateProvider: new MutableEquipmentStateProvider("idle"));
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);

        using var preconditionFailure = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "STOP" }, "capability-precondition-1");
        Assert.Equal(HttpStatusCode.BadRequest, preconditionFailure.StatusCode);
        Assert.Equal("application/problem+json", preconditionFailure.Content.Headers.ContentType!.MediaType);
        using var problem = JsonDocument.Parse(await preconditionFailure.Content.ReadAsStringAsync());
        Assert.Equal("Command precondition not met", problem.RootElement.GetProperty("title").GetString());
        Assert.Equal("INVALID_COMMAND", problem.RootElement.GetProperty("errorCode").GetString());
        Assert.Contains("running", problem.RootElement.GetProperty("detail").GetString());
        Assert.Contains("idle", problem.RootElement.GetProperty("detail").GetString());

        using var allowed = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "capability-precondition-allowed-1");
        Assert.Equal(HttpStatusCode.Accepted, allowed.StatusCode);
    }

    [Fact]
    public async Task IdempotencyReplaySkipsCurrentCapabilityAndStateValidation()
    {
        var state = new MutableEquipmentStateProvider("running");
        using var factory = Factory(
            capabilitySettings:
            [
                ("Fab:EquipmentCapabilities:Fabs:FAB-01:Equipment:equipment-0:Actions:0", "START"),
                ("Fab:EquipmentCapabilities:Fabs:FAB-01:Equipment:equipment-0:Actions:1", "STOP"),
                ("Fab:EquipmentCapabilities:Fabs:FAB-01:Equipment:equipment-0:Preconditions:STOP", "running")
            ],
            stateProvider: state);
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        const string replayKey = "replay-before-validation-1";
        var body = new { fabId, equipmentId = "equipment-0", action = "STOP" };

        using var first = await PostCommandAsync(client, siteId, body, replayKey);
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        var commandId = await CommandIdAsync(first);

        // The equipment moves out of the precondition state; a same-key retry must still replay the original 202.
        state.State = "idle";
        using var replay = await PostCommandAsync(client, siteId, body, replayKey);
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        using var replayDocument = JsonDocument.Parse(await replay.Content.ReadAsStringAsync());
        Assert.Equal(commandId, replayDocument.RootElement.GetProperty("commandId").GetString());
        Assert.Equal(0, replayDocument.RootElement.GetProperty("revision").GetInt32());
        Assert.Equal("accepted", replayDocument.RootElement.GetProperty("outcome").GetString());

        // A brand-new command must fail the current precondition.
        using var fresh = await PostCommandAsync(client, siteId, body, "replay-before-validation-2");
        Assert.Equal(HttpStatusCode.BadRequest, fresh.StatusCode);
        using var problem = JsonDocument.Parse(await fresh.Content.ReadAsStringAsync());
        Assert.Equal("Command precondition not met", problem.RootElement.GetProperty("title").GetString());
        Assert.Equal("INVALID_COMMAND", problem.RootElement.GetProperty("errorCode").GetString());
    }

    [Fact]
    public async Task CommandStreamRequiresFabScopeAndRejectsUnknownFab()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, _) = await SiteAsync(client);

        using var missing = await client.GetAsync($"/api/v1/sites/{siteId}/commands/stream");
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal("application/problem+json", missing.Content.Headers.ContentType!.MediaType);

        using var invalid = await client.GetAsync($"/api/v1/sites/{siteId}/commands/stream?fabId=not-a-guid");
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);

        using var unknownFab = await client.GetAsync($"/api/v1/sites/{siteId}/commands/stream?fabId={Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, unknownFab.StatusCode);
        Assert.Equal("application/problem+json", unknownFab.Content.Headers.ContentType!.MediaType);
    }

    [Fact]
    public async Task SingleFabCommandStreamRejectsForeignIdentityAndRetainsLifecycle()
    {
        var siteId = SiteDirectory.DemoSiteId.ToString("D");
        var fabId = SiteDirectory.CreateFab(1).Id.ToString("D");
        var foreignFabId = Guid.NewGuid().ToString("D");
        using var factory = Factory(fabAuthorization: new FabScopedAuthorization(fabId));
        using var client = Authorized(factory);

        var service = factory.Services.GetRequiredService<EquipmentCommandService>();
        var rejected = service.Submit(Guid.Parse(siteId),
            new EquipmentCommandRequest(foreignFabId, "equipment-0", "START"), Principal, "foreign-stream-fab");
        Assert.Equal(EquipmentCommandSubmitStatus.UnknownFab, rejected.Status);
        Assert.Null(rejected.Command);
        Assert.Empty(service.ReadJournal(Guid.Parse(siteId), null).Events);

        using var submit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "stream-fab-auth-1");
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var commandId = await CommandIdAsync(submit);

        using var denied = await client.GetAsync($"/api/v1/sites/{siteId}/commands/stream?fabId={foreignFabId}");
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
        Assert.Equal("application/problem+json", denied.Content.Headers.ContentType!.MediaType);

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await OpenCommandStreamAsync(client, siteId, fabId, lastEventId: null, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        var fabIds = new List<string>();
        var revisions = new List<int>();
        var outcomes = new List<string>();
        while (fabIds.Count < 3)
        {
            var envelope = await ReadEnvelopeAsync(reader, timeout.Token)
                ?? throw new XunitException("The FAB-scoped command stream ended before the lifecycle arrived.");
            var payload = envelope.GetProperty("payload");
            Assert.Equal(commandId, payload.GetProperty("commandId").GetString());
            fabIds.Add(payload.GetProperty("fabId").GetString()!);
            revisions.Add(payload.GetProperty("revision").GetInt32());
            outcomes.Add(payload.GetProperty("outcome").GetString()!);
        }
        Assert.All(fabIds, eventFabId => Assert.Equal(fabId, eventFabId));
        Assert.DoesNotContain(foreignFabId, fabIds);
        Assert.Equal(new[] { 0, 1, 2 }, revisions);
        Assert.Equal(new[] { "accepted", "executing", "succeeded" }, outcomes);

        using var denyingFactory = Factory(denyFabAccess: true);
        using var deniedClient = Authorized(denyingFactory);
        using var deniedKnownFab = await deniedClient.GetAsync($"/api/v1/sites/{siteId}/commands/stream?fabId={fabId}");
        Assert.Equal(HttpStatusCode.NotFound, deniedKnownFab.StatusCode);
        Assert.Equal("application/problem+json", deniedKnownFab.Content.Headers.ContentType!.MediaType);
    }

    [Fact]
    public async Task FabScopedStatusAndTelemetryEndpointsEnforceAuthorization()
    {
        var siteId = SiteDirectory.DemoSiteId.ToString("D");
        var fabId = SiteDirectory.CreateFab(1).Id.ToString("D");
        using var factory = Factory(fabAuthorization: new FabScopedAuthorization(fabId));
        using var client = Authorized(factory);

        using var allowedStatus = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/equipment-status");
        Assert.Equal(HttpStatusCode.OK, allowedStatus.StatusCode);

        using var denyingFactory = Factory(denyFabAccess: true);
        using var deniedClient = Authorized(denyingFactory);
        using var deniedStatus = await deniedClient.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/equipment-status");
        Assert.Equal(HttpStatusCode.NotFound, deniedStatus.StatusCode);
        Assert.Equal("application/problem+json", deniedStatus.Content.Headers.ContentType!.MediaType);

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var allowedTelemetry = await client.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/telemetry/stream",
            HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, allowedTelemetry.StatusCode);
        await using var telemetryBody = await allowedTelemetry.Content.ReadAsStreamAsync(timeout.Token);
        using var telemetryReader = new StreamReader(telemetryBody, Encoding.UTF8);
        Assert.NotNull(await ReadEnvelopeAsync(telemetryReader, timeout.Token));

        using var deniedTelemetry = await deniedClient.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/telemetry/stream");
        Assert.Equal(HttpStatusCode.NotFound, deniedTelemetry.StatusCode);

        using var deniedStatusStream = await deniedClient.GetAsync($"/api/v1/sites/{siteId}/fabs/{fabId}/equipment-status/stream");
        Assert.Equal(HttpStatusCode.NotFound, deniedStatusStream.StatusCode);
    }

    [Fact]
    public async Task CommandStreamCursorAheadSignalsReplayGap()
    {
        using var factory = Factory();
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);
        var service = factory.Services.GetRequiredService<EquipmentCommandService>();
        using var submit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "cursor-ahead-1");
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var commandId = await CommandIdAsync(submit);
        var latest = service.ReadJournal(Guid.Parse(siteId), null).LatestSequence;
        var ahead = $"{service.GetJournalEpoch(Guid.Parse(siteId)):D}:{latest + 100}";

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await OpenCommandStreamAsync(client, siteId, fabId, ahead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        var gap = await ReadSseEventAsync(reader, timeout.Token)
            ?? throw new XunitException("The command stream ended before the ahead-cursor replay-gap signal.");
        Assert.Equal("replay-gap", gap.Event);
        Assert.Null(gap.Id);
        Assert.NotNull(gap.Data);
        var gapData = gap.Data!.Value;
        Assert.True(gapData.GetProperty("replayGap").GetBoolean());
        Assert.Equal(ahead, gapData.GetProperty("requestedLastEventId").GetString());
        Assert.True(gapData.GetProperty("latestSequence").GetInt64() >= 1);

        var replayed = await ReadSseEventAsync(reader, timeout.Token)
            ?? throw new XunitException("The command stream ended before replaying retained events after the ahead-cursor gap.");
        Assert.Null(replayed.Event);
        Assert.Equal(commandId, replayed.Data!.Value.GetProperty("payload").GetProperty("commandId").GetString());
    }

    [Fact]
    public async Task CommandStreamEmitsLiveReplayGapWhenJournalTrims()
    {
        using var factory = Factory(commandOptions: new EquipmentCommandOptions
        {
            ExecutingDelay = TimeSpan.FromMilliseconds(1),
            SucceededDelay = TimeSpan.FromMilliseconds(2),
            MaxJournalEventsPerSite = 1
        });
        using var client = Authorized(factory);
        var (siteId, fabId) = await SiteAsync(client);

        using var timeout = new CancellationTokenSource(StreamTimeout);
        using var response = await OpenCommandStreamAsync(client, siteId, fabId, lastEventId: null, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(body, Encoding.UTF8);

        using var submit = await PostCommandAsync(client, siteId,
            new { fabId, equipmentId = "equipment-0", action = "START" }, "live-gap-1");
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var commandId = await CommandIdAsync(submit);
        await PollUntilAsync(client, commandId, status => status.GetProperty("revision").GetInt32() == 2, PollTimeout);

        var sawGap = false;
        var gapFirstRetained = 0L;
        JsonElement? retained = null;
        var sawDirty = false;
        while (retained is null)
        {
            var sse = await ReadSseEventAsync(reader, timeout.Token)
                ?? throw new XunitException("The command stream ended before the live replay-gap was observed.");
            if (sse.Event == "replay-gap")
            {
                sawGap = true;
                gapFirstRetained = sse.Data!.Value.GetProperty("firstRetainedSequence").GetInt64();
                continue;
            }
            if (sse.Event == "dirty")
            {
                // A retention trim is a real data loss: the control frame must carry the dropped count.
                sawDirty = true;
                Assert.Null(sse.Id);
                Assert.Equal("retention-trim", sse.Data!.Value.GetProperty("reason").GetString());
                Assert.True(sse.Data!.Value.GetProperty("droppedCount").GetInt64() >= 1);
                continue;
            }
            if (!sawGap || sse.Data is null) continue;
            retained = sse.Data;
        }

        Assert.True(sawGap);
        Assert.True(sawDirty, "A pruned cursor must emit an explicit dirty control frame.");
        Assert.True(gapFirstRetained > 1, "The retained journal must have trimmed away earlier events.");
        var payload = retained!.Value.GetProperty("payload");
        Assert.Equal(commandId, payload.GetProperty("commandId").GetString());
        Assert.Equal(2, payload.GetProperty("revision").GetInt32());
        Assert.Equal("succeeded", payload.GetProperty("outcome").GetString());
    }

    private static async Task<(string SiteId, string FabId)> SiteAsync(HttpClient client)
    {
        var sites = await client.GetFromJsonAsync<SiteDto[]>("/api/v1/sites");
        var site = Assert.Single(sites!);
        return (site.SiteId, Assert.Single(site.Fabs).FabId);
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
        string fabId, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync($"/api/v1/sites/{siteId}/commands/stream?fabId={fabId}",
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

    private static async Task<string> CommandIdAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("commandId").GetString()!;
    }

    private static async Task<HttpResponseMessage> OpenCommandStreamAsync(HttpClient client, string siteId, string fabId,
        string? lastEventId, CancellationToken cancellationToken)
    {
        using var message = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/sites/{siteId}/commands/stream?fabId={fabId}");
        if (lastEventId is not null) message.Headers.TryAddWithoutValidation("Last-Event-ID", lastEventId);
        return await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
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

    private static WebApplicationFactory<Program> Factory(bool denyFabAccess = false, EquipmentCommandOptions? commandOptions = null,
        (string Setting, string Value)[]? capabilitySettings = null, IEquipmentStateProvider? stateProvider = null,
        IFabAuthorization? fabAuthorization = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
        {
            host.UseEnvironment("Development");
            host.UseSetting("Fab:DevelopmentKey", Key);
            host.UseSetting("Fab:DataDirectory", TestDataDirectory.Create());
            host.UseSetting("Fab:EmbeddedWorker", "false");
            if (capabilitySettings is not null)
            {
                foreach (var (setting, value) in capabilitySettings) host.UseSetting(setting, value);
            }
            host.ConfigureTestServices(services =>
            {
                if (denyFabAccess)
                {
                    services.RemoveAll<IFabAuthorization>();
                    services.AddSingleton<IFabAuthorization>(new DenyingFabAuthorization());
                }
                if (fabAuthorization is not null)
                {
                    services.RemoveAll<IFabAuthorization>();
                    services.AddSingleton<IFabAuthorization>(fabAuthorization);
                }
                if (commandOptions is not null)
                {
                    services.RemoveAll<EquipmentCommandService>();
                    services.AddSingleton(provider => new EquipmentCommandService(
                        provider.GetRequiredService<ICommandStore>(),
                        provider.GetRequiredService<SiteDirectory>(), TimeProvider.System, commandOptions,
                        provider.GetRequiredService<IEquipmentCommandValidator>()));
                }
                if (stateProvider is not null)
                {
                    services.RemoveAll<IEquipmentStateProvider>();
                    services.AddSingleton<IEquipmentStateProvider>(stateProvider);
                }
            });
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

    private sealed class MutableEquipmentStateProvider(string state) : IEquipmentStateProvider
    {
        public string State { get; set; } = state;

        public string? GetState(Guid siteId, FabUnit fab, string equipmentId) => State;
    }

    private sealed class FabScopedAuthorization(string allowedFabId) : IFabAuthorization
    {
        public bool IsAuthorized(Guid siteId, Guid fabId, ClaimsPrincipal principal) =>
            string.Equals(fabId.ToString("D"), allowedFabId, StringComparison.Ordinal);
    }
}
