/**
 * - `idle`: no socket; an alarm is pending if the shard should (re)connect.
 * - `connecting`: fetching Get Gateway Bot or opening the socket.
 * - `handshaking`: socket open, waiting for Hello, then Ready or Resumed.
 * - `ready`: session established; dispatches are flowing.
 */
export type ConnectionPhase = "connecting" | "handshaking" | "idle" | "ready";

/** Configuration a shard receives from the scheduled reconciler. */
export interface ShardConfig {
  shardId: number;
  shardCount: number;
  maxConcurrency: number;
}

/** Everything a shard needs to survive eviction, crashes and code updates. */
export interface ShardState extends ShardConfig {
  enabled: boolean;
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  sequence: number | null;
  reconnectAttempts: number;
  fatalCloseCode: number | null;
  fatalFingerprint: string | null;
}

/** A shard state that has everything needed to send Resume. */
export interface ResumableShardState extends ShardState {
  sessionId: string;
  resumeGatewayUrl: string;
  sequence: number;
}

/** The activities shown so far in the current rotation cycle, keyed by `activityKey`. */
export interface ShownActivities {
  current: string | null;
  shown: ReadonlySet<string>;
}

export interface EnsureResult {
  /** Shard count this shard had before the call, or null if it had never been configured. */
  previousShardCount: number | null;
  /** False if a non-retryable close code is holding the shard down. */
  running: boolean;
}

export interface ShardStatus {
  phase: ConnectionPhase;
  shardId: number | null;
  shardCount: number | null;
  enabled: boolean;
  hasSession: boolean;
  sequence: number | null;
  reconnectAttempts: number;
  fatalCloseCode: number | null;
  heartbeatIntervalMs: number | null;
  latencyMs: number | null;
}
