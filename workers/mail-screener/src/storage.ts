import { hostSuffixes } from "./decide.ts";
import type {
  AddedVia,
  Dmarc,
  Review,
  ReviewDecision,
  ReviewStatus,
  RuleKind,
  RuleList,
  Sender,
  SenderRule,
  StoredRule,
} from "./types/screener.ts";

// oxlint-disable-next-line typescript/consistent-type-definitions -- SqlStorage.exec needs an index-signature-compatible type
type SenderRow = {
  kind: RuleKind;
  pattern: string;
  list: RuleList;
  note: string | null;
  added_at: number;
  added_via: AddedVia;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- SqlStorage.exec needs an index-signature-compatible type
type ReviewRow = {
  id: string;
  from_addr: string;
  from_name: string | null;
  subject: string;
  count: number;
  received_at: number;
  dmarc: Dmarc;
  card_version: number;
  status: ReviewStatus;
  decision: ReviewDecision | null;
  decided_at: number | null;
};

/** Ordered schema migrations; append new entries, never edit applied ones. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE senders (
    kind TEXT NOT NULL CHECK (kind IN ('address', 'domain', 'org')),
    pattern TEXT NOT NULL,
    list TEXT NOT NULL CHECK (list IN ('allow', 'deny')),
    note TEXT,
    added_at INTEGER NOT NULL,
    added_via TEXT NOT NULL CHECK (added_via IN ('discord', 'seed', 'cli')),
    PRIMARY KEY (kind, pattern)
  )`,
  `CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    from_addr TEXT NOT NULL,
    from_name TEXT,
    subject TEXT NOT NULL,
    count INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    dmarc TEXT NOT NULL CHECK (dmarc IN ('pass', 'fail', 'none')),
    card_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'allowed', 'blocked', 'dismissed')),
    decision TEXT,
    decided_at INTEGER
  )`,
  // A sender has at most one open review; later messages bump it
  "CREATE UNIQUE INDEX reviews_open_sender ON reviews (from_addr) WHERE status = 'open'",
  "CREATE INDEX reviews_open_received ON reviews (received_at) WHERE status = 'open'",
];

/**
 * Turns a `senders` row into a rule.
 *
 * @param {SenderRow} row - The row.
 * @returns {StoredRule} The rule.
 */
function toRule(row: SenderRow): StoredRule {
  return {
    kind: row.kind,
    pattern: row.pattern,
    list: row.list,
    note: row.note,
    addedAt: row.added_at,
    addedVia: row.added_via,
  };
}

/**
 * Turns a `reviews` row into a review.
 *
 * @param {ReviewRow} row - The row.
 * @returns {Review} The review.
 */
function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    fromAddr: row.from_addr,
    fromName: row.from_name,
    subject: row.subject,
    count: row.count,
    receivedAt: row.received_at,
    dmarc: row.dmarc,
    cardVersion: row.card_version,
    status: row.status,
    decision: row.decision,
    decidedAt: row.decided_at,
  };
}

/** Typed access to the Screener's sender rules and reviews in its SQLite storage. */
export default class ScreenerStorage {
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

  /**
   * Runs storage calls as one transaction.
   *
   * @param {() => T} run - The calls.
   * @returns {T} What `run` returned.
   */
  public transaction<T>(run: () => T): T {
    return this.#storage.transactionSync(run);
  }

  /**
   * Reads the rules that could match a sender: its address, its exact host, and its host and every parent as org
   * patterns.
   *
   * @param {Sender} sender - The sender.
   * @returns {SenderRule[]} The candidate rules.
   */
  public rulesFor(sender: Sender): SenderRule[] {
    const suffixes = hostSuffixes(sender.domain);
    return this.#storage.sql
      .exec<Pick<SenderRow, "kind" | "pattern" | "list">>(
        `SELECT kind, pattern, list FROM senders
         WHERE (kind = 'address' AND pattern = ?)
            OR (kind = 'domain' AND pattern = ?)
            OR (kind = 'org' AND pattern IN (${suffixes.map(() => "?").join(", ")}))`,
        sender.address,
        sender.domain,
        ...suffixes,
      )
      .toArray();
  }

  /**
   * Adds a rule, or replaces the one with the same kind and pattern.
   *
   * @param {StoredRule} rule - The rule, with its pattern normalized.
   * @returns {StoredRule} The stored rule.
   */
  public putRule(rule: StoredRule): StoredRule {
    return toRule(
      this.#storage.sql
        .exec<SenderRow>(
          `INSERT INTO senders (kind, pattern, list, note, added_at, added_via) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, pattern) DO UPDATE SET
             list = excluded.list,
             note = excluded.note,
             added_at = excluded.added_at,
             added_via = excluded.added_via
           RETURNING *`,
          rule.kind,
          rule.pattern,
          rule.list,
          rule.note,
          rule.addedAt,
          rule.addedVia,
        )
        .one(),
    );
  }

  /**
   * Removes a rule.
   *
   * @param {RuleKind} kind - The rule's kind.
   * @param {string} pattern - The rule's normalized pattern.
   * @returns {boolean} Whether there was a rule to remove.
   */
  public deleteRule(kind: RuleKind, pattern: string): boolean {
    const cursor = this.#storage.sql.exec("DELETE FROM senders WHERE kind = ? AND pattern = ?", kind, pattern);
    return cursor.rowsWritten > 0;
  }

  /**
   * Lists the stored rules, most specific kind first, then by pattern.
   *
   * @param {RuleList | undefined} list - Only this list's rules, or every rule if left out.
   * @returns {StoredRule[]} The rules.
   */
  public listRules(list?: RuleList): StoredRule[] {
    const order = "ORDER BY CASE kind WHEN 'address' THEN 0 WHEN 'domain' THEN 1 ELSE 2 END, pattern";
    const cursor =
      list === undefined
        ? this.#storage.sql.exec<SenderRow>(`SELECT * FROM senders ${order}`)
        : this.#storage.sql.exec<SenderRow>(`SELECT * FROM senders WHERE list = ? ${order}`, list);
    return cursor.toArray().map(toRule);
  }

  /**
   * Reads a review.
   *
   * @param {string} reviewId - The review's ID.
   * @returns {Review | null} The review, or `null` if there's none with that ID.
   */
  public getReview(reviewId: string): Review | null {
    const [row] = this.#storage.sql.exec<ReviewRow>("SELECT * FROM reviews WHERE id = ?", reviewId).toArray();
    return row === undefined ? null : toReview(row);
  }

  /**
   * Reads a sender's open review.
   *
   * @param {string} fromAddr - The sender's normalized address.
   * @returns {Review | null} The open review, or `null` if the sender has none.
   */
  public getOpenReview(fromAddr: string): Review | null {
    const [row] = this.#storage.sql
      .exec<ReviewRow>("SELECT * FROM reviews WHERE from_addr = ? AND status = 'open'", fromAddr)
      .toArray();
    return row === undefined ? null : toReview(row);
  }

  /**
   * Stores a new review.
   *
   * @param {Review} review - The review.
   */
  public insertReview(review: Review): void {
    this.#storage.sql.exec(
      `INSERT INTO reviews
         (id, from_addr, from_name, subject, count, received_at, dmarc, card_version, status, decision, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id,
      review.fromAddr,
      review.fromName,
      review.subject,
      review.count,
      review.receivedAt,
      review.dmarc,
      review.cardVersion,
      review.status,
      review.decision,
      review.decidedAt,
    );
  }

  /**
   * Counts another message on an open review and raises its card version for the updated card.
   *
   * @param {string} reviewId - The review's ID.
   * @returns {Review} The bumped review.
   */
  public bumpReview(reviewId: string): Review {
    return toReview(
      this.#storage.sql
        .exec<ReviewRow>(
          "UPDATE reviews SET count = count + 1, card_version = card_version + 1 WHERE id = ? RETURNING *",
          reviewId,
        )
        .one(),
    );
  }

  /**
   * Closes an open review and raises its card version for the decided card.
   *
   * @param {string} reviewId - The review's ID.
   * @param {Exclude<ReviewStatus, "open">} status - The review's new status.
   * @param {ReviewDecision} decision - How it was decided.
   * @param {number} decidedAt - When, as Unix time in milliseconds.
   * @returns {Review | null} The closed review, or `null` if it wasn't open.
   */
  public closeReview(
    reviewId: string,
    status: Exclude<ReviewStatus, "open">,
    decision: ReviewDecision,
    decidedAt: number,
  ): Review | null {
    const [row] = this.#storage.sql
      .exec<ReviewRow>(
        `UPDATE reviews SET status = ?, decision = ?, decided_at = ?, card_version = card_version + 1
         WHERE id = ? AND status = 'open'
         RETURNING *`,
        status,
        decision,
        decidedAt,
        reviewId,
      )
      .toArray();
    return row === undefined ? null : toReview(row);
  }

  /**
   * Deletes a review, e.g. one whose first card couldn't be queued.
   *
   * @param {string} reviewId - The review's ID.
   */
  public deleteReview(reviewId: string): void {
    this.#storage.sql.exec("DELETE FROM reviews WHERE id = ?", reviewId);
  }

  /**
   * Lists the open reviews, oldest first.
   *
   * @param {number | undefined} receivedBefore - Only reviews whose first message arrived at or before this time.
   * @returns {Review[]} The open reviews.
   */
  public listOpenReviews(receivedBefore?: number): Review[] {
    const cursor =
      receivedBefore === undefined
        ? this.#storage.sql.exec<ReviewRow>("SELECT * FROM reviews WHERE status = 'open' ORDER BY received_at, id")
        : this.#storage.sql.exec<ReviewRow>(
            "SELECT * FROM reviews WHERE status = 'open' AND received_at <= ? ORDER BY received_at, id",
            receivedBefore,
          );
    return cursor.toArray().map(toReview);
  }
}
