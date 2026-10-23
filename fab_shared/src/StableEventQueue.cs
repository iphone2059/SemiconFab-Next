namespace Fab.Simulation;

public sealed record ScheduledEvent(long TimeUs, int Priority, long EnqueueSequence, int Lot, string Kind);

public sealed class StableEventQueue
{
    private readonly PriorityQueue<ScheduledEvent, (long Time, int Priority, long Sequence)> _queue = new();
    private readonly HashSet<long> _usedSequences = [];
    public int Count => _queue.Count;
    public void Enqueue(ScheduledEvent value)
    {
        if (value.TimeUs < 0 || value.Priority < 0 || value.EnqueueSequence < 1)
            throw new ArgumentException("Invalid event ordering key.", nameof(value));
        if (!_usedSequences.Add(value.EnqueueSequence))
            throw new ArgumentException("Enqueue sequence may not be reused.", nameof(value));
        _queue.Enqueue(value, (value.TimeUs, value.Priority, value.EnqueueSequence));
    }
    public ScheduledEvent Peek() => _queue.Peek();
    public ScheduledEvent Dequeue() => _queue.Dequeue();
    public ScheduledEvent[] Snapshot() => _queue.UnorderedItems.Select(x => x.Element)
        .OrderBy(x => x.TimeUs).ThenBy(x => x.Priority).ThenBy(x => x.EnqueueSequence).ToArray();
}
