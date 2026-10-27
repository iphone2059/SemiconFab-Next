using System.Collections.Concurrent;
using Fab.Site;

namespace Fab.App;

/// <summary>Request body for the development equipment command endpoint.</summary>
public sealed record EquipmentCommandRequest(string FabId, string EquipmentId, string Action);

/// <summary>Authoritative state of one simulated equipment command. Revisions 0/1/2 map to accepted/executing/succeeded.</summary>
public sealed record EquipmentCommandStatus(
    string SiteId,
    string FabId,
    string EquipmentId,
    string Action,
    string CommandId,
    int Revision,
    string Outcome,
    string OccurredAt);

/// <summary>SSE payload of the command.result topic; deliberately does not duplicate the command action.</summary>
public sealed record EquipmentCommandStreamPayload(string FabId, string CommandId, int Revision, string Outcome, string OccurredAt);

/// <summary>SSE envelope of the command.result topic.</summary>
public sealed record EquipmentCommandStreamEnvelope(string Topic, long Sequence, EquipmentCommandStreamPayload Payload);

public enum EquipmentCommandSubmitStatus
{
    Accepted,
    UnknownSite,
    UnknownFab
}

public sealed record EquipmentCommandSubmitResult(EquipmentCommandSubmitStatus Status, EquipmentCommandStatus? Command);

/// <summary>
/// Development-only, in-memory equipment command simulation. It gives the preview an
/// authoritative command lifecycle (accepted -> executing -> succeeded) and a replayable
/// per-Site event journal for the SSE stream, and is meant to be replaced by a real
/// SEMI E30/E40 command adapter later.
///
/// The service deliberately owns no persistence: commands vanish when the process exits.
/// </summary>
public sealed class EquipmentCommandService
{
    public const string CommandResultTopic = "command.result";
    public const string AcceptedOutcome = "accepted";
    public const string ExecutingOutcome = "executing";
    public const string SucceededOutcome = "succeeded";
    public const int MaxEquipmentIdLength = 128;
    public const int MaxActionLength = 64;
    public const int ExecutingDelayMilliseconds = 150;
    public const int SucceededDelayMilliseconds = 600;
    public const int StreamPollMilliseconds = 50;
    public const int MaxJournalEventsPerSite = 4096;

    private readonly SiteDirectory directory;
    private readonly ConcurrentDictionary<Guid, EquipmentCommandStatus> commands = new();
    private readonly ConcurrentDictionary<Guid, SiteCommandJournal> journals = new();

    public EquipmentCommandService(SiteDirectory directory)
    {
        ArgumentNullException.ThrowIfNull(directory);
        this.directory = directory;
    }

    private sealed class SiteCommandJournal
    {
        public readonly object Gate = new();
        public readonly List<EquipmentCommandStreamEnvelope> Events = [];
        public long Sequence;
    }

    /// <summary>Validates only the request shape; Site/FAB membership is validated by <see cref="Submit"/>.</summary>
    public static bool TryValidate(EquipmentCommandRequest? request, out string error)
    {
        if (request is null)
        {
            error = "A command request body is required.";
            return false;
        }
        if (string.IsNullOrWhiteSpace(request.FabId))
        {
            error = "fabId is required.";
            return false;
        }
        if (string.IsNullOrWhiteSpace(request.EquipmentId) || request.EquipmentId.Length > MaxEquipmentIdLength)
        {
            error = $"equipmentId must be a non-empty string of at most {MaxEquipmentIdLength} characters.";
            return false;
        }
        if (string.IsNullOrWhiteSpace(request.Action) || request.Action.Length > MaxActionLength)
        {
            error = $"action must be a non-empty string of at most {MaxActionLength} characters.";
            return false;
        }
        error = "";
        return true;
    }

    /// <summary>Returns the authoritative current state, or null for an unknown command id.</summary>
    public EquipmentCommandStatus? Get(Guid commandId) =>
        commands.TryGetValue(commandId, out var status) ? status : null;

    /// <summary>
    /// Validates Site/FAB membership, records revision 0 (accepted), and schedules the
    /// background simulation of revisions 1 (executing) and 2 (succeeded).
    /// </summary>
    public EquipmentCommandSubmitResult Submit(Guid siteId, EquipmentCommandRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!directory.TryGetSite(siteId, out _))
            return new(EquipmentCommandSubmitStatus.UnknownSite, null);
        if (!Guid.TryParse(request.FabId, out var fabId) || !directory.TryGetFab(siteId, fabId, out var fab))
            return new(EquipmentCommandSubmitStatus.UnknownFab, null);

        var commandId = Guid.NewGuid();
        var accepted = new EquipmentCommandStatus(
            siteId.ToString("D"),
            fab.Id.ToString("D"),
            request.EquipmentId,
            request.Action,
            commandId.ToString("D"),
            0,
            AcceptedOutcome,
            DateTimeOffset.UtcNow.ToString("O"));
        commands[commandId] = accepted;
        Append(siteId, accepted);
        _ = SimulateAsync(siteId, commandId);
        return new(EquipmentCommandSubmitStatus.Accepted, accepted);
    }

    /// <summary>Returns the journal events for a Site whose per-Site sequence is greater than <paramref name="sequenceExclusive"/>.</summary>
    public EquipmentCommandStreamEnvelope[] ReadJournalSince(Guid siteId, long sequenceExclusive)
    {
        if (!journals.TryGetValue(siteId, out var journal)) return [];
        lock (journal.Gate)
        {
            var start = 0;
            while (start < journal.Events.Count && journal.Events[start].Sequence <= sequenceExclusive) start++;
            return start == journal.Events.Count ? [] : journal.Events.GetRange(start, journal.Events.Count - start).ToArray();
        }
    }

    private async Task SimulateAsync(Guid siteId, Guid commandId)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(ExecutingDelayMilliseconds)).ConfigureAwait(false);
            Advance(siteId, commandId, 1, ExecutingOutcome);
            await Task.Delay(TimeSpan.FromMilliseconds(SucceededDelayMilliseconds - ExecutingDelayMilliseconds)).ConfigureAwait(false);
            Advance(siteId, commandId, 2, SucceededOutcome);
        }
        catch
        {
            // Development-only simulation: background transitions must never surface as request failures.
        }
    }

    private void Advance(Guid siteId, Guid commandId, int revision, string outcome)
    {
        if (!commands.TryGetValue(commandId, out var current)) return;
        var next = current with
        {
            Revision = revision,
            Outcome = outcome,
            OccurredAt = DateTimeOffset.UtcNow.ToString("O")
        };
        commands[commandId] = next;
        Append(siteId, next);
    }

    private void Append(Guid siteId, EquipmentCommandStatus status)
    {
        var journal = journals.GetOrAdd(siteId, _ => new SiteCommandJournal());
        lock (journal.Gate)
        {
            journal.Sequence++;
            journal.Events.Add(new EquipmentCommandStreamEnvelope(
                CommandResultTopic,
                journal.Sequence,
                new EquipmentCommandStreamPayload(status.FabId, status.CommandId, status.Revision, status.Outcome, status.OccurredAt)));
            if (journal.Events.Count > MaxJournalEventsPerSite)
                journal.Events.RemoveRange(0, journal.Events.Count - MaxJournalEventsPerSite);
        }
    }
}
