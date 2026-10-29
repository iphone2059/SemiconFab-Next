using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Fab.App;

/// <summary>
/// Development command store backed by one SQLite database (ADR-012 2.1): WAL journal mode,
/// <c>synchronous=FULL</c>, foreign keys on, 5 s busy timeout, one writer per Site. Every mutation
/// (submit, advance, retention) is exactly one database transaction, so a crash can only expose a
/// fully committed prefix: no command without its idempotency row, no journal event out of sync
/// with the command revision, and no site-state cursor ahead of the committed journal.
///
/// Only local single-process/single-writer use is supported (Development scope); multi-process
/// writers are not supported and are documented as such.
/// </summary>
public sealed class SqliteCommandStore : ICommandStore
{
    private const int BusyTimeoutMilliseconds = 5000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private const string SchemaSql = @"
CREATE TABLE IF NOT EXISTS site_state (
    site_id TEXT NOT NULL PRIMARY KEY,
    epoch TEXT NOT NULL,
    first_retained INTEGER NOT NULL,
    latest_sequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
    command_id TEXT NOT NULL PRIMARY KEY,
    site_id TEXT NOT NULL,
    fab_id TEXT NOT NULL,
    equipment_id TEXT NOT NULL,
    action TEXT NOT NULL,
    revision INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    terminal INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    terminal_at TEXT NULL
);
CREATE TABLE IF NOT EXISTS journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch TEXT NOT NULL,
    fab_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
    site_id TEXT NOT NULL,
    fab_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    command_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (site_id, fab_id, principal, key),
    FOREIGN KEY (command_id) REFERENCES commands (command_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS journal_sequence_idx ON journal (sequence);
";

    private readonly string databasePath;
    private readonly string connectionString;
    private readonly ICommandStoreFaultInjector faultInjector;
    private readonly ConcurrentDictionary<Guid, SiteGate> sites = new();
    private readonly object schemaGate = new();

    public SqliteCommandStore(string databasePath, ICommandStoreFaultInjector? faultInjector = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        this.databasePath = Path.GetFullPath(databasePath);
        if (this.databasePath.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Development command storage requires a local disk file.", nameof(databasePath));
        this.faultInjector = faultInjector ?? NoCommandStoreFaultInjector.Instance;
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = this.databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = true,
            DefaultTimeout = BusyTimeoutMilliseconds
        }.ToString();
        Guard(() =>
        {
            Directory.CreateDirectory(Path.GetDirectoryName(this.databasePath)!);
            Initialize();
            return true;
        });
    }

    public CommandStoreRecovery Recover(Guid siteId) => Guard(() =>
    {
        var gate = sites.GetOrAdd(siteId, _ => new SiteGate());
        gate.Semaphore.Wait();
        try
        {
            if (gate.Recovery is not null) return gate.Recovery;
            var diagnostics = new List<string>();
            using var connection = Open();
            EnsureSiteState(connection, siteId, diagnostics);
            var state = ReadSiteState(connection, siteId, transaction: null)
                        ?? throw new CommandStoreException("The durable command store has no Site state.");
            var epoch = ParseGuid(state.Epoch, "site_state.epoch");
            var commands = ReadCommands(connection, siteId);
            var events = ReadJournal(connection, state.FirstRetained, epoch);
            var idempotency = ReadIdempotency(connection, siteId);
            ValidateCommittedState(siteId, state, epoch, commands, events, idempotency);
            var firstRetained = EffectiveFirstRetained(state, events);
            gate.Epoch = epoch;
            gate.FirstRetained = firstRetained;
            gate.Latest = state.LatestSequence;
            gate.Loaded = true;
            var recovery = new CommandStoreRecovery(epoch, firstRetained, state.LatestSequence, events,
                commands, idempotency, diagnostics.ToArray());
            gate.Recovery = recovery;
            return recovery;
        }
        finally
        {
            gate.Semaphore.Release();
        }
    });

    public CommandStoreSubmitResult CommitSubmit(Guid siteId, CommandPersistedRecord command, CommandIdempotencyRecord idempotency) => Guard(() =>
    {
        var gate = RequireSite(siteId);
        gate.Semaphore.Wait();
        try
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction(deferred: false);
            try
            {
                var existing = FindIdempotency(connection, transaction, idempotency);
                if (existing is not null)
                {
                    if (!string.Equals(existing.RequestHash, idempotency.RequestHash, StringComparison.Ordinal))
                        return new CommandStoreSubmitResult(CommandStoreSubmitStatus.PayloadMismatch, Idempotency: existing);
                    var stored = ReadCommand(connection, transaction, existing.CommandId)
                                 ?? throw new CommandStoreException("Idempotency row references a missing command.");
                    return new CommandStoreSubmitResult(CommandStoreSubmitStatus.Replayed, Command: stored, Idempotency: existing);
                }

                var state = ReadSiteState(connection, siteId, transaction)
                            ?? throw new CommandStoreException("The durable command store has no Site state.");
                InsertCommand(connection, transaction, command);
                faultInjector.Reach(CommandStoreFaultPoints.AfterCommandInsert);
                InsertIdempotency(connection, transaction, idempotency);
                faultInjector.Reach(CommandStoreFaultPoints.AfterIdempotencyInsert);
                var journalEvent = InsertJournal(connection, transaction, state.Epoch, command);
                faultInjector.Reach(CommandStoreFaultPoints.AfterJournalInsert);
                var firstRetained = state.FirstRetained == 0 ? journalEvent.Sequence : state.FirstRetained;
                UpdateSiteState(connection, transaction, siteId, firstRetained, journalEvent.Sequence);
                faultInjector.Reach(CommandStoreFaultPoints.BeforeCommit);
                transaction.Commit();
                faultInjector.Reach(CommandStoreFaultPoints.AfterCommitBeforeResponse);
                faultInjector.Reach(CommandStoreFaultPoints.BeforeCommitReturn);
                gate.FirstRetained = firstRetained;
                gate.Latest = journalEvent.Sequence;
                return new CommandStoreSubmitResult(CommandStoreSubmitStatus.Accepted, journalEvent, command, idempotency);
            }
            catch
            {
                TryRollback(transaction);
                throw;
            }
        }
        finally
        {
            gate.Semaphore.Release();
        }
    });

    public CommandJournalEvent? CommitAdvance(Guid siteId, string commandId, int expectedRevision, int revision,
        string outcome, string occurredAt, string? terminalAt) => Guard(() =>
    {
        var gate = RequireSite(siteId);
        gate.Semaphore.Wait();
        try
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction(deferred: false);
            try
            {
                var command = ReadCommand(connection, transaction, commandId);
                if (command is null || command.Revision >= revision || command.Revision != expectedRevision) return null;
                UpdateCommandRevision(connection, transaction, commandId, revision, outcome, occurredAt, terminalAt);
                var state = ReadSiteState(connection, siteId, transaction)
                            ?? throw new CommandStoreException("The durable command store has no Site state.");
                var advanced = command with { Revision = revision, Outcome = outcome, OccurredAt = occurredAt, TerminalAt = terminalAt };
                var journalEvent = InsertJournal(connection, transaction, state.Epoch, advanced);
                faultInjector.Reach(CommandStoreFaultPoints.AfterJournalInsert);
                UpdateSiteState(connection, transaction, siteId, state.FirstRetained, journalEvent.Sequence);
                faultInjector.Reach(CommandStoreFaultPoints.BeforeCommit);
                transaction.Commit();
                faultInjector.Reach(CommandStoreFaultPoints.AfterCommitBeforeResponse);
                gate.Latest = journalEvent.Sequence;
                return journalEvent;
            }
            catch
            {
                TryRollback(transaction);
                throw;
            }
        }
        finally
        {
            gate.Semaphore.Release();
        }
    });

    public void CommitRetention(Guid siteId, CommandRetentionUpdate update) => Guard(() =>
    {
        ArgumentNullException.ThrowIfNull(update);
        var gate = RequireSite(siteId);
        gate.Semaphore.Wait();
        try
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction(deferred: false);
            try
            {
                var state = ReadSiteState(connection, siteId, transaction)
                            ?? throw new CommandStoreException("The durable command store has no Site state.");
                if (update.FirstRetainedSequence < 0 || update.FirstRetainedSequence > state.LatestSequence + 1)
                    throw new CommandStoreException("Retention cursor is outside the durable journal window.");
                foreach (var commandId in update.PrunedCommandIds)
                {
                    if (!Guid.TryParse(commandId, out _)) throw new CommandStoreException("Pruned command id is not a GUID.");
                    DeleteJournalRows(connection, transaction, commandId);
                    DeleteCommandRow(connection, transaction, commandId);
                }
                DeleteJournalRowsBefore(connection, transaction, update.FirstRetainedSequence);
                UpdateSiteState(connection, transaction, siteId, update.FirstRetainedSequence, state.LatestSequence);
                faultInjector.Reach(CommandStoreFaultPoints.DuringPrune);
                transaction.Commit();
                gate.FirstRetained = update.FirstRetainedSequence;
            }
            catch
            {
                TryRollback(transaction);
                throw;
            }
        }
        finally
        {
            gate.Semaphore.Release();
        }
    });

    /// <summary>Effective first retained sequence used by cursors; an empty retained window starts at latest+1.</summary>
    private static long EffectiveFirstRetained(SiteStateRow state, CommandJournalEvent[] events) =>
        events.Length > 0 ? events[0].Sequence : state.LatestSequence == 0 ? 0 : state.LatestSequence + 1;

    private void Initialize()
    {
        lock (schemaGate)
        {
            using var connection = Open();
            using (var wal = connection.CreateCommand())
            {
                wal.CommandText = "PRAGMA journal_mode=WAL;";
                var mode = Convert.ToString(wal.ExecuteScalar(), CultureInfo.InvariantCulture);
                if (!string.Equals(mode, "wal", StringComparison.OrdinalIgnoreCase))
                    throw new CommandStoreException("The durable command store could not enable WAL journal mode.");
            }
            using var schema = connection.CreateCommand();
            schema.CommandText = SchemaSql;
            schema.ExecuteNonQuery();
        }
    }

    private SqliteConnection Open()
    {
        try
        {
            var connection = new SqliteConnection(connectionString);
            connection.Open();
            using var pragmas = connection.CreateCommand();
            pragmas.CommandText = "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=" + BusyTimeoutMilliseconds + ";";
            pragmas.ExecuteNonQuery();
            return connection;
        }
        catch (Exception error) when (error is SqliteException or IOException or UnauthorizedAccessException)
        {
            throw new CommandStoreException("Cannot open the durable command store.", error);
        }
    }

    private void EnsureSiteState(SqliteConnection connection, Guid siteId, List<string> diagnostics)
    {
        using var transaction = connection.BeginTransaction(deferred: false);
        if (ReadSiteState(connection, siteId, transaction) is not null)
        {
            transaction.Commit();
            return;
        }
        if (HasCommittedData(connection, transaction))
            throw new CommandStoreException("The durable command store contains data without Site state; refusing to start.");
        using (var insert = Command(connection, transaction, @"
INSERT INTO site_state (site_id, epoch, first_retained, latest_sequence) VALUES ($site, $epoch, 0, 0);"))
        {
            insert.Parameters.AddWithValue("$site", siteId.ToString("D"));
            insert.Parameters.AddWithValue("$epoch", Guid.NewGuid().ToString("D"));
            insert.ExecuteNonQuery();
        }
        transaction.Commit();
        diagnostics.Add("site-state-created");
    }

    private static bool HasCommittedData(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var command = Command(connection, transaction, @"
SELECT EXISTS(SELECT 1 FROM commands) OR EXISTS(SELECT 1 FROM journal) OR EXISTS(SELECT 1 FROM idempotency);");
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture) != 0;
    }

    private SiteStateRow? ReadSiteState(SqliteConnection connection, Guid siteId, SqliteTransaction? transaction)
    {
        using var command = Command(connection, transaction, @"
SELECT epoch, first_retained, latest_sequence FROM site_state WHERE site_id = $site;");
        command.Parameters.AddWithValue("$site", siteId.ToString("D"));
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return null;
        return new SiteStateRow(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2));
    }

    private CommandPersistedRecord[] ReadCommands(SqliteConnection connection, Guid siteId)
    {
        using var command = Command(connection, null, @"
SELECT command_id, site_id, fab_id, equipment_id, action, revision, outcome, occurred_at, created_at, terminal_at
FROM commands WHERE site_id = $site ORDER BY command_id;");
        command.Parameters.AddWithValue("$site", siteId.ToString("D"));
        using var reader = command.ExecuteReader();
        var commands = new List<CommandPersistedRecord>();
        while (reader.Read())
        {
            commands.Add(new CommandPersistedRecord(
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(0),
                reader.GetInt32(5),
                reader.GetString(6),
                reader.GetString(8),
                reader.GetString(7),
                reader.IsDBNull(9) ? null : reader.GetString(9)));
        }
        return commands.ToArray();
    }

    private CommandPersistedRecord? ReadCommand(SqliteConnection connection, SqliteTransaction transaction, string commandId)
    {
        using var command = Command(connection, transaction, @"
SELECT command_id, site_id, fab_id, equipment_id, action, revision, outcome, occurred_at, created_at, terminal_at
FROM commands WHERE command_id = $id;");
        command.Parameters.AddWithValue("$id", commandId);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return null;
        return new CommandPersistedRecord(
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(0),
            reader.GetInt32(5),
            reader.GetString(6),
            reader.GetString(8),
            reader.GetString(7),
            reader.IsDBNull(9) ? null : reader.GetString(9));
    }

    private CommandJournalEvent[] ReadJournal(SqliteConnection connection, long firstRetained, Guid expectedEpoch)
    {
        using var command = Command(connection, null, @"
SELECT sequence, epoch, fab_id, command_id, revision, outcome, occurred_at
FROM journal WHERE sequence >= $first ORDER BY sequence;");
        command.Parameters.AddWithValue("$first", firstRetained);
        using var reader = command.ExecuteReader();
        var events = new List<CommandJournalEvent>();
        while (reader.Read())
        {
            var epoch = ParseGuid(reader.GetString(1), "journal.epoch");
            if (epoch != expectedEpoch)
                throw new CommandStoreException("The durable journal contains events from a different epoch.");
            events.Add(new CommandJournalEvent(
                reader.GetInt64(0),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetInt32(4),
                reader.GetString(5),
                reader.GetString(6)));
        }
        return events.ToArray();
    }

    private CommandIdempotencyRecord[] ReadIdempotency(SqliteConnection connection, Guid siteId)
    {
        using var command = Command(connection, null, @"
SELECT site_id, fab_id, principal, key, payload_hash, command_id, response_json, created_at
FROM idempotency WHERE site_id = $site ORDER BY created_at, key;");
        command.Parameters.AddWithValue("$site", siteId.ToString("D"));
        using var reader = command.ExecuteReader();
        var entries = new List<CommandIdempotencyRecord>();
        while (reader.Read())
        {
            entries.Add(new CommandIdempotencyRecord(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(5),
                reader.GetString(6),
                reader.GetString(7)));
        }
        return entries.ToArray();
    }

    private CommandIdempotencyRecord? FindIdempotency(SqliteConnection connection, SqliteTransaction transaction,
        CommandIdempotencyRecord candidate)
    {
        using var command = Command(connection, transaction, @"
SELECT site_id, fab_id, principal, key, payload_hash, command_id, response_json, created_at
FROM idempotency WHERE site_id = $site AND fab_id = $fab AND principal = $principal AND key = $key;");
        command.Parameters.AddWithValue("$site", candidate.SiteId);
        command.Parameters.AddWithValue("$fab", candidate.FabId);
        command.Parameters.AddWithValue("$principal", candidate.Principal);
        command.Parameters.AddWithValue("$key", candidate.Key);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return null;
        return new CommandIdempotencyRecord(reader.GetString(0), reader.GetString(1), reader.GetString(2),
            reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7));
    }

    private void InsertCommand(SqliteConnection connection, SqliteTransaction transaction, CommandPersistedRecord command)
    {
        using var insert = Command(connection, transaction, @"
INSERT INTO commands (command_id, site_id, fab_id, equipment_id, action, revision, outcome, occurred_at, terminal, created_at, terminal_at)
VALUES ($id, $site, $fab, $equipment, $action, $revision, $outcome, $occurred, $terminal, $created, $terminalAt);");
        insert.Parameters.AddWithValue("$id", command.CommandId);
        insert.Parameters.AddWithValue("$site", command.SiteId);
        insert.Parameters.AddWithValue("$fab", command.FabId);
        insert.Parameters.AddWithValue("$equipment", command.EquipmentId);
        insert.Parameters.AddWithValue("$action", command.Action);
        insert.Parameters.AddWithValue("$revision", command.Revision);
        insert.Parameters.AddWithValue("$outcome", command.Outcome);
        insert.Parameters.AddWithValue("$occurred", command.OccurredAt);
        insert.Parameters.AddWithValue("$terminal", command.Revision >= 2 ? 1 : 0);
        insert.Parameters.AddWithValue("$created", command.CreatedAt);
        insert.Parameters.AddWithValue("$terminalAt", (object?)command.TerminalAt ?? DBNull.Value);
        insert.ExecuteNonQuery();
    }

    private void InsertIdempotency(SqliteConnection connection, SqliteTransaction transaction, CommandIdempotencyRecord entry)
    {
        using var insert = Command(connection, transaction, @"
INSERT INTO idempotency (site_id, fab_id, principal, key, payload_hash, command_id, response_json, created_at)
VALUES ($site, $fab, $principal, $key, $hash, $command, $response, $created);");
        insert.Parameters.AddWithValue("$site", entry.SiteId);
        insert.Parameters.AddWithValue("$fab", entry.FabId);
        insert.Parameters.AddWithValue("$principal", entry.Principal);
        insert.Parameters.AddWithValue("$key", entry.Key);
        insert.Parameters.AddWithValue("$hash", entry.RequestHash);
        insert.Parameters.AddWithValue("$command", entry.CommandId);
        insert.Parameters.AddWithValue("$response", entry.ResponseJson);
        insert.Parameters.AddWithValue("$created", entry.CreatedAt);
        insert.ExecuteNonQuery();
    }

    private CommandJournalEvent InsertJournal(SqliteConnection connection, SqliteTransaction transaction, string epoch,
        CommandPersistedRecord command)
    {
        using (var insert = Command(connection, transaction, @"
INSERT INTO journal (epoch, fab_id, command_id, revision, outcome, occurred_at)
VALUES ($epoch, $fab, $command, $revision, $outcome, $occurred);"))
        {
            insert.Parameters.AddWithValue("$epoch", epoch);
            insert.Parameters.AddWithValue("$fab", command.FabId);
            insert.Parameters.AddWithValue("$command", command.CommandId);
            insert.Parameters.AddWithValue("$revision", command.Revision);
            insert.Parameters.AddWithValue("$outcome", command.Outcome);
            insert.Parameters.AddWithValue("$occurred", command.OccurredAt);
            insert.ExecuteNonQuery();
        }
        using var sequenceCommand = Command(connection, transaction, "SELECT last_insert_rowid();");
        var sequence = Convert.ToInt64(sequenceCommand.ExecuteScalar(), CultureInfo.InvariantCulture);
        return new CommandJournalEvent(sequence, command.FabId, command.CommandId, command.Revision, command.Outcome, command.OccurredAt);
    }

    private static void UpdateCommandRevision(SqliteConnection connection, SqliteTransaction transaction, string commandId,
        int revision, string outcome, string occurredAt, string? terminalAt)
    {
        using var update = Command(connection, transaction, @"
UPDATE commands SET revision = $revision, outcome = $outcome, occurred_at = $occurred, terminal = $terminal, terminal_at = $terminalAt
WHERE command_id = $id;");
        update.Parameters.AddWithValue("$revision", revision);
        update.Parameters.AddWithValue("$outcome", outcome);
        update.Parameters.AddWithValue("$occurred", occurredAt);
        update.Parameters.AddWithValue("$terminal", revision >= 2 ? 1 : 0);
        update.Parameters.AddWithValue("$terminalAt", (object?)terminalAt ?? DBNull.Value);
        update.Parameters.AddWithValue("$id", commandId);
        update.ExecuteNonQuery();
    }

    private static void UpdateSiteState(SqliteConnection connection, SqliteTransaction transaction, Guid siteId,
        long firstRetained, long latestSequence)
    {
        using var update = Command(connection, transaction, @"
UPDATE site_state SET first_retained = $first, latest_sequence = $latest WHERE site_id = $site;");
        update.Parameters.AddWithValue("$first", firstRetained);
        update.Parameters.AddWithValue("$latest", latestSequence);
        update.Parameters.AddWithValue("$site", siteId.ToString("D"));
        if (update.ExecuteNonQuery() != 1)
            throw new CommandStoreException("The durable command store has no Site state to update.");
    }

    private static void DeleteJournalRows(SqliteConnection connection, SqliteTransaction transaction, string commandId)
    {
        using var delete = Command(connection, transaction, "DELETE FROM journal WHERE command_id = $command;");
        delete.Parameters.AddWithValue("$command", commandId);
        delete.ExecuteNonQuery();
    }

    private static void DeleteJournalRowsBefore(SqliteConnection connection, SqliteTransaction transaction, long firstRetained)
    {
        using var delete = Command(connection, transaction, "DELETE FROM journal WHERE sequence < $first;");
        delete.Parameters.AddWithValue("$first", firstRetained);
        delete.ExecuteNonQuery();
    }

    private static void DeleteCommandRow(SqliteConnection connection, SqliteTransaction transaction, string commandId)
    {
        using var delete = Command(connection, transaction, "DELETE FROM commands WHERE command_id = $command;");
        delete.Parameters.AddWithValue("$command", commandId);
        delete.ExecuteNonQuery();
    }

    private static void ValidateCommittedState(Guid siteId, SiteStateRow state, Guid epoch,
        IReadOnlyList<CommandPersistedRecord> commands, IReadOnlyList<CommandJournalEvent> events,
        IReadOnlyList<CommandIdempotencyRecord> idempotency)
    {
        if (state.FirstRetained < 0 || state.FirstRetained > state.LatestSequence + 1)
            throw new CommandStoreException("The durable retention cursor is invalid.");
        var commandIds = new HashSet<string>(commands.Select(command => command.CommandId), StringComparer.Ordinal);
        var idempotencyCommandIds = new HashSet<string>(idempotency.Select(entry => entry.CommandId), StringComparer.Ordinal);
        if (commands.Count != idempotency.Count || !commandIds.SetEquals(idempotencyCommandIds))
            throw new CommandStoreException("Committed commands and idempotency entries are inconsistent.");
        foreach (var command in commands)
        {
            if (!string.Equals(command.SiteId, siteId.ToString("D"), StringComparison.Ordinal))
                throw new CommandStoreException("The durable command store contains commands for another Site.");
            if (!Guid.TryParse(command.CommandId, out _) || !Guid.TryParse(command.FabId, out _))
                throw new CommandStoreException("A committed command identity is invalid.");
            if (command.Revision is < 0 or > 2) throw new CommandStoreException("A committed command revision is invalid.");
            if (string.IsNullOrWhiteSpace(command.Outcome) || string.IsNullOrWhiteSpace(command.EquipmentId) ||
                string.IsNullOrWhiteSpace(command.Action))
                throw new CommandStoreException("A committed command record is incomplete.");
        }
        var latestEventByCommand = new Dictionary<string, CommandJournalEvent>(StringComparer.Ordinal);
        long previousSequence = 0;
        foreach (var journalEvent in events)
        {
            if (journalEvent.Sequence <= previousSequence)
                throw new CommandStoreException("The durable journal is not strictly increasing.");
            previousSequence = journalEvent.Sequence;
            if (!Guid.TryParse(journalEvent.CommandId, out _) || !Guid.TryParse(journalEvent.FabId, out _))
                throw new CommandStoreException("A committed journal event identity is invalid.");
            if (journalEvent.Revision is < 0 or > 2 || string.IsNullOrWhiteSpace(journalEvent.Outcome))
                throw new CommandStoreException("A committed journal event is invalid.");
            if (!commandIds.Contains(journalEvent.CommandId))
                throw new CommandStoreException("A committed journal event references a missing command.");
            latestEventByCommand[journalEvent.CommandId] = journalEvent;
        }
        if (state.LatestSequence < previousSequence)
            throw new CommandStoreException("The durable Site sequence is behind the committed journal.");
        foreach (var command in commands)
        {
            if (!latestEventByCommand.TryGetValue(command.CommandId, out var journalEvent)) continue;
            if (journalEvent.Revision != command.Revision)
                throw new CommandStoreException("A committed journal event does not match its command revision.");
        }
        foreach (var entry in idempotency)
        {
            if (!string.Equals(entry.SiteId, siteId.ToString("D"), StringComparison.Ordinal) ||
                !Guid.TryParse(entry.FabId, out _) || !Guid.TryParse(entry.CommandId, out _))
                throw new CommandStoreException("A committed idempotency entry is invalid.");
            try
            {
                using var document = JsonDocument.Parse(entry.ResponseJson);
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                    throw new CommandStoreException("A committed idempotency response is not a JSON object.");
            }
            catch (JsonException error)
            {
                throw new CommandStoreException("A committed idempotency response is not valid JSON.", error);
            }
        }
        _ = epoch;
    }

    private static Guid ParseGuid(string value, string field) =>
        Guid.TryParse(value, out var parsed) ? parsed : throw new CommandStoreException($"The durable command store has an invalid {field}.");

    private static SqliteCommand Command(SqliteConnection connection, SqliteTransaction? transaction, string sql)
    {
        var command = connection.CreateCommand();
        command.CommandText = sql;
        if (transaction is not null) command.Transaction = transaction;
        return command;
    }

    private static void TryRollback(SqliteTransaction transaction)
    {
        try
        {
            transaction.Rollback();
        }
        catch (Exception error) when (error is SqliteException or InvalidOperationException or ObjectDisposedException)
        {
            // The connection may already be gone when a simulated crash aborts the transaction; SQLite
            // then rolls the uncommitted transaction back itself when the connection closes.
        }
    }

    private SiteGate RequireSite(Guid siteId)
    {
        if (!sites.TryGetValue(siteId, out var gate) || !gate.Loaded)
            throw new CommandStoreException($"The command store for Site {siteId:D} was not recovered before use.");
        return gate;
    }

    private static void Guard(Action action) => Guard(() =>
    {
        action();
        return true;
    });

    private static T Guard<T>(Func<T> action)
    {
        try
        {
            return action();
        }
        catch (CommandStoreException)
        {
            throw;
        }
        catch (InjectedCommandStoreFaultException)
        {
            throw;
        }
        catch (Exception error) when (error is SqliteException or IOException or UnauthorizedAccessException or InvalidOperationException or JsonException)
        {
            throw new CommandStoreException("Durable command store operation failed.", error);
        }
    }

    private sealed class SiteGate
    {
        public SemaphoreSlim Semaphore { get; } = new(1, 1);
        public Guid Epoch { get; set; }
        public long FirstRetained { get; set; }
        public long Latest { get; set; }
        public bool Loaded { get; set; }
        public CommandStoreRecovery? Recovery { get; set; }
    }

    private readonly record struct SiteStateRow(string Epoch, long FirstRetained, long LatestSequence);
}