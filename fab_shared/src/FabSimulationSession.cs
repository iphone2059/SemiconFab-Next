using System.Globalization;
using System.Text.Json;
using Fab.Contracts;
using Fab.Simulation;

namespace Fab.Simulation;

internal sealed record SimulationState(string EngineVersion, ScenarioDefinition Scenario, string FabId, long ClockUs,
    long NextEnqueueSequence, long EventSequence, long DurableEventSequence, ScheduledEvent? LastProcessedKey,
    ulong RngState, ScheduledEvent[] PendingEvents, int[] WaitingLots, int ActiveLot, bool StartPending,
    long CompletedLots, long BusyTimeUs, bool Finished, SimulationEventDto[] Events);

/// <summary>Single-owner synchronous session; stepping and checkpointing occur at complete event boundaries.</summary>
public sealed class FabSimulationSession
{
    internal const string EngineVersion = "synthetic-fifo-v1";
    private readonly ScenarioDefinition _scenario;
    private readonly SyntheticFifoModel _model;
    private readonly long _duration;
    private readonly long _warmup;
    private StableEventQueue _queue = new();
    private readonly Queue<int> _waiting = new();
    private readonly List<SimulationEventDto> _events;
    private readonly string?[] _lotText;
    private SplitMix64 _rng;
    private long _clock, _nextEnqueue = 1, _eventSequence, _completed, _busy;
    private int _active;
    private bool _startPending, _finished;
    private ScheduledEvent? _last;
    private long _clockTextValue;
    private string? _clockText;

    internal FabSimulationSession(ScenarioDefinition scenario, SyntheticFifoModel model)
    {
        _scenario = scenario;
        _model = model;
        _events = new(checked(3 * model.LotCount)); // one release, start and completion per lot
        _lotText = new string?[model.LotCount + 1];
        _duration = FabSimulation.ParseTime(scenario.DurationUs, nameof(scenario.DurationUs), true);
        _warmup = FabSimulation.ParseTime(scenario.WarmupUs, nameof(scenario.WarmupUs), false);
        _rng = new(SplitMix64.Derive(FabSimulation.ParseSeed(scenario.MasterSeed), model.FabId));
        for (var lot = 1; lot <= model.LotCount; lot++) Schedule(0, 0, lot, "LotReleased");
    }

    public bool StepOneEvent(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_finished) return false;
        if (_queue.Count == 0 || _queue.Peek().TimeUs >= _duration)
        {
            _clock = _duration;
            _finished = true;
            return false;
        }
        var current = _queue.Dequeue();
        _clock = current.TimeUs;
        _last = current;
        switch (current.Kind)
        {
            case "LotReleased":
                _waiting.Enqueue(current.Lot);
                ScheduleStart();
                break;
            case "OperationStarted":
                _startPending = false;
                _active = _waiting.Dequeue();
                var finish = checked(_clock + _model.ServiceTime(_rng.Next()));
                _busy = checked(_busy + Math.Max(0, Math.Min(finish, _duration) - Math.Max(_clock, _warmup)));
                Schedule(finish, 1, _active, "OperationCompleted");
                break;
            case "OperationCompleted":
                if (_clock >= _warmup) _completed++;
                _active = 0;
                ScheduleStart();
                break;
            default: throw new InvalidOperationException("Unknown internal event kind.");
        }
        _events.Add(new(_model.FabId, LotText(current.Lot), current.Kind, ClockText(), Text(checked(++_eventSequence))));
        return true;
    }

    private void ScheduleStart()
    {
        if (_active == 0 && !_startPending && _waiting.Count > 0)
        {
            _startPending = true;
            Schedule(_clock, 2, _waiting.Peek(), "OperationStarted");
        }
    }

    private void Schedule(long time, int priority, int lot, string kind)
    {
        var next = new ScheduledEvent(time, priority, _nextEnqueue, lot, kind);
        if (_last is { } last && Comparer<(long, int, long)>.Default.Compare((time, priority, _nextEnqueue), (last.TimeUs, last.Priority, last.EnqueueSequence)) <= 0)
            throw new InvalidOperationException("A child event must follow its causal parent.");
        _nextEnqueue = checked(_nextEnqueue + 1);
        _queue.Enqueue(next);
    }

    public FabSimulationResult RunToCompletion(CancellationToken cancellationToken = default)
    {
        while (StepOneEvent(cancellationToken)) { }
        var semantic = JsonSerializer.Serialize(new { Version = EngineVersion, _model.FabId, _model.Code, _model.LotCount,
            _model.ProcessTimeUs, DurationUs = Text(_duration), WarmupUs = Text(_warmup), CompletedLots = Text(_completed),
            BusyTimeUs = Text(_busy), RngState = Text(_rng.State), Events = _events });
        return new(_model.FabId, Text(_completed), _model.LotCount.ToString(CultureInfo.InvariantCulture), Text(_duration), Text(_busy), FabSimulation.Digest(semantic), _events.ToArray());
    }

    public SimulationCheckpoint CreateCheckpoint()
    {
        var json = JsonSerializer.Serialize(CaptureState());
        return new(1, json, FabSimulation.Digest(json));
    }

    internal SimulationState CaptureState() => new(EngineVersion, _scenario, _model.FabId, _clock, _nextEnqueue,
        _eventSequence, _eventSequence, _last, _rng.State, _queue.Snapshot(), _waiting.ToArray(), _active,
        _startPending, _completed, _busy, _finished, _events.ToArray());

    internal static FabSimulationSession Restore(SimulationState state)
    {
        var session = new FabSimulation().Start(state.Scenario, state.FabId);
        session._queue = new();
        foreach (var pending in state.PendingEvents) session._queue.Enqueue(pending);
        foreach (var lot in state.WaitingLots) session._waiting.Enqueue(lot);
        session._events.AddRange(state.Events);
        session._clock = state.ClockUs;
        session._nextEnqueue = state.NextEnqueueSequence;
        session._eventSequence = state.EventSequence;
        session._last = state.LastProcessedKey;
        session._rng = new(state.RngState);
        session._active = state.ActiveLot;
        session._startPending = state.StartPending;
        session._completed = state.CompletedLots;
        session._busy = state.BusyTimeUs;
        session._finished = state.Finished;
        return session;
    }

    // Per-event formatting caches: lots recur, and batched events often share one simulation time.
    // Cached strings are ordinary invariant strings, so event DTOs and digest bytes are unchanged.
    private string LotText(int lot) => lot >= 0 && lot < _lotText.Length
        ? _lotText[lot] ??= lot.ToString(CultureInfo.InvariantCulture)
        : lot.ToString(CultureInfo.InvariantCulture);

    private string ClockText()
    {
        if (_clockText is null || _clockTextValue != _clock)
        {
            _clockTextValue = _clock;
            _clockText = _clock.ToString(CultureInfo.InvariantCulture);
        }
        return _clockText;
    }

    private static string Text(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static string Text(ulong value) => value.ToString(CultureInfo.InvariantCulture);
}
