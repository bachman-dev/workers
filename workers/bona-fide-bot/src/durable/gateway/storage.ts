import type { ShardConfig, ShardState, ShownActivities } from "./types.ts";

// oxlint-disable-next-line typescript/consistent-type-definitions -- SqlStorage.exec needs an index-signature-compatible type
type ShardRow = {
  shard_id: number;
  shard_count: number;
  max_concurrency: number;
  enabled: number;
  session_id: string | null;
  resume_gateway_url: string | null;
  sequence: number | null;
  reconnect_attempts: number;
  fatal_close_code: number | null;
  fatal_fingerprint: string | null;
};

/** Ordered schema migrations; append new entries, never edit applied ones. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE shard (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    shard_id INTEGER NOT NULL,
    shard_count INTEGER NOT NULL,
    max_concurrency INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    resume_gateway_url TEXT,
    sequence INTEGER,
    reconnect_attempts INTEGER NOT NULL DEFAULT 0,
    fatal_close_code INTEGER,
    fatal_fingerprint TEXT
  )`,
  `CREATE TABLE shown_activities (
    key TEXT PRIMARY KEY,
    shown_at INTEGER NOT NULL
  )`,
];

/** Typed access to the shard's state in the Durable Object's SQLite storage. */
export default class ShardStorage {
  readonly #storage: DurableObjectStorage;

  public constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  /** Applies pending migrations atomically. SQL calls are synchronous, so this is safe to run in the constructor. */
  public migrate(): void {
    this.#storage.transactionSync(() => {
      const { sql } = this.#storage;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      const applied = sql
        .exec<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_migrations")
        .one();
      const current = applied.version ?? 0;
      for (const [index, migration] of MIGRATIONS.entries()) {
        const version = index + 1;
        if (version > current) {
          sql.exec(migration);
          sql.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", version, Date.now());
        }
      }
    });
  }

  public get(): ShardState | null {
    const [row] = this.#storage.sql.exec<ShardRow>("SELECT * FROM shard WHERE id = 0").toArray();
    if (typeof row === "undefined") {
      return null;
    }
    return {
      enabled: row.enabled === 1,
      fatalCloseCode: row.fatal_close_code,
      fatalFingerprint: row.fatal_fingerprint,
      maxConcurrency: row.max_concurrency,
      reconnectAttempts: row.reconnect_attempts,
      resumeGatewayUrl: row.resume_gateway_url,
      sequence: row.sequence,
      sessionId: row.session_id,
      shardCount: row.shard_count,
      shardId: row.shard_id,
    };
  }

  /**
   * Stores the shard's config and enables it, creating the row on first use.
   *
   * @param {ShardConfig} config - The shard's ID, total shard count and identify concurrency.
   */
  public configure(config: ShardConfig): void {
    this.#storage.sql.exec(
      `INSERT INTO shard (id, shard_id, shard_count, max_concurrency, enabled)
       VALUES (0, ?, ?, ?, 1)
       ON CONFLICT (id) DO UPDATE SET
         shard_id = excluded.shard_id,
         shard_count = excluded.shard_count,
         max_concurrency = excluded.max_concurrency,
         enabled = 1`,
      config.shardId,
      config.shardCount,
      config.maxConcurrency,
    );
  }

  public disable(): void {
    this.#storage.sql.exec("UPDATE shard SET enabled = 0 WHERE id = 0");
  }

  /**
   * Saves the resume info from Ready; a new session also means the reconnect streak is over.
   *
   * @param {string} sessionId - The Ready event's `session_id`.
   * @param {string} resumeGatewayUrl - The Ready event's `resume_gateway_url`.
   * @param {number} sequence - The Ready event's sequence number.
   */
  public saveSession(sessionId: string, resumeGatewayUrl: string, sequence: number): void {
    this.#storage.sql.exec(
      "UPDATE shard SET session_id = ?, resume_gateway_url = ?, sequence = ?, reconnect_attempts = 0 WHERE id = 0",
      sessionId,
      resumeGatewayUrl,
      sequence,
    );
  }

  public saveSequence(sequence: number): void {
    this.#storage.sql.exec("UPDATE shard SET sequence = ? WHERE id = 0", sequence);
  }

  public clearSession(): void {
    this.#storage.sql.exec(
      "UPDATE shard SET session_id = NULL, resume_gateway_url = NULL, sequence = NULL WHERE id = 0",
    );
  }

  /**
   * Records another reconnect attempt.
   *
   * @returns {number} How many reconnects have been attempted since the last Ready or Resumed.
   */
  public incrementReconnectAttempts(): number {
    const row = this.#storage.sql
      .exec<{ reconnect_attempts: number }>(
        "UPDATE shard SET reconnect_attempts = reconnect_attempts + 1 WHERE id = 0 RETURNING reconnect_attempts",
      )
      .toArray()
      .at(0);
    return row?.reconnect_attempts ?? 1;
  }

  public resetReconnectAttempts(): void {
    this.#storage.sql.exec("UPDATE shard SET reconnect_attempts = 0 WHERE id = 0");
  }

  public setFatal(closeCode: number, fingerprint: string): void {
    this.#storage.sql.exec(
      "UPDATE shard SET fatal_close_code = ?, fatal_fingerprint = ? WHERE id = 0",
      closeCode,
      fingerprint,
    );
  }

  public clearFatal(): void {
    this.#storage.sql.exec("UPDATE shard SET fatal_close_code = NULL, fatal_fingerprint = NULL WHERE id = 0");
  }

  /**
   * Reads which activities have been shown in the current rotation cycle.
   *
   * @returns {ShownActivities} The keys shown so far, and the one showing now.
   */
  public getShownActivities(): ShownActivities {
    const rows = this.#storage.sql
      .exec<{ key: string }>("SELECT key FROM shown_activities ORDER BY shown_at DESC")
      .toArray();
    return { current: rows.at(0)?.key ?? null, shown: new Set(rows.map((row) => row.key)) };
  }

  /**
   * Records an activity as shown, clearing the previous cycle first if this one starts a new cycle.
   *
   * @param {string} key - The activity's key.
   * @param {boolean} startsCycle - Whether every activity had already been shown.
   */
  public recordShownActivity(key: string, startsCycle: boolean): void {
    this.#storage.transactionSync(() => {
      if (startsCycle) {
        this.#storage.sql.exec("DELETE FROM shown_activities");
      }
      this.#storage.sql.exec(
        `INSERT INTO shown_activities (key, shown_at) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET shown_at = excluded.shown_at`,
        key,
        Date.now(),
      );
    });
  }
}
