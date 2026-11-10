import {
  GatewayCloseCodes,
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  GatewayOpcodes,
  type GatewayReceivePayload,
  type GatewaySendPayload,
  GatewayVersion,
} from "@bachman-dev/workers-shared/discord";
import { log } from "@bachman-dev/workers-shared/util";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../types/cloudflare.ts";
import { getGatewayBot, isUnauthorizedError } from "./gateway/api.ts";
import {
  ACTIVITY_ROTATION_INTERVAL_MS,
  FATAL_CLOSE_CODES,
  GATEWAY_INTENTS,
  HELLO_TIMEOUT_MS,
  IDENTIFY_BUCKET_INTERVAL_MS,
  IDENTIFY_PROPERTIES,
  INVALID_SESSION_MAX_DELAY_MS,
  INVALID_SESSION_MIN_DELAY_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_MS,
  RECONNECT_MAX_DELAY_MS,
  RESUMABLE_CLOSE_CODE,
  SESSION_ENDING_CLOSE_CODE,
  SESSION_INVALIDATING_CLOSE_CODES,
} from "./gateway/constants.ts";
import { type DispatchContext, handleDispatch } from "./gateway/dispatch/index.ts";
import { pickQuip, toPresence } from "./gateway/presence.ts";
import ShardStorage from "./gateway/storage.ts";
import type {
  ConnectionPhase,
  EnsureResult,
  ResumableShardState,
  ShardConfig,
  ShardState,
  ShardStatus,
} from "./gateway/types.ts";

const HEX_RADIX = 16;
const HEX_BYTE_LENGTH = 2;
/** Backoff doubles per attempt after the first, immediate retry. */
const BACKOFF_FACTOR = 2;
const BACKOFF_FREE_ATTEMPTS = 2;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * First retry goes out right away; after that the delay doubles up to the cap. All include jitter.
 *
 * @param {number} attempts - Reconnects attempted since the last Ready or Resumed, including this one.
 * @returns {number} Milliseconds to wait before reconnecting.
 */
function reconnectDelay(attempts: number): number {
  const jitter = Math.random() * RECONNECT_JITTER_MS;
  if (attempts <= 1) {
    return jitter;
  }
  const backoff = RECONNECT_BASE_DELAY_MS * BACKOFF_FACTOR ** (attempts - BACKOFF_FREE_ATTEMPTS);
  return Math.min(backoff, RECONNECT_MAX_DELAY_MS) + jitter;
}

/**
 * Finds the next top of the hour, in UTC, after a time.
 *
 * @param {number} now - A Unix time in milliseconds.
 * @returns {number} The Unix time in milliseconds of the next hour boundary.
 */
function nextTopOfHour(now: number): number {
  return (Math.floor(now / ACTIVITY_ROTATION_INTERVAL_MS) + 1) * ACTIVITY_ROTATION_INTERVAL_MS;
}

/**
 * Shards start in `max_concurrency`-sized buckets, in order, one bucket per identify window.
 *
 * @param {ShardConfig} config - The shard's config.
 * @returns {number} Milliseconds this shard waits before its first identify.
 */
function identifyDelay(config: ShardConfig): number {
  return Math.floor(config.shardId / Math.max(config.maxConcurrency, 1)) * IDENTIFY_BUCKET_INTERVAL_MS;
}

function canResume(state: ShardState): state is ResumableShardState {
  return state.sessionId !== null && state.resumeGatewayUrl !== null && state.sequence !== null;
}

function isReceivePayload(value: unknown): value is GatewayReceivePayload {
  return typeof value === "object" && value !== null && "op" in value && typeof value.op === "number";
}

function parsePayload(data: string): GatewayReceivePayload | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    log("warn", "Gateway message is not valid JSON", error);
  }
  return isReceivePayload(parsed) ? parsed : null;
}

/**
 * Opens a JSON-encoded, uncompressed gateway socket. Workers open outbound WebSockets via fetch with an Upgrade; the
 * caller adds its listeners and then calls `accept()`.
 *
 * @param {string} gatewayUrl - The `wss://` URL from Get Gateway Bot or Ready's `resume_gateway_url`.
 * @returns {Promise<WebSocket>} The socket, not yet accepted.
 */
async function openSocket(gatewayUrl: string): Promise<WebSocket> {
  const url = new URL(gatewayUrl);
  url.protocol = "https:";
  url.searchParams.set("v", GatewayVersion);
  url.searchParams.set("encoding", "json");
  const response = await fetch(url, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error(`Gateway did not accept the WebSocket upgrade (HTTP ${response.status})`);
  }
  return socket;
}

/**
 * One Discord Gateway shard, addressed by name from the scheduled handler (see `shardName`).
 *
 * The single alarm drives the whole lifecycle: it is the heartbeat and activity rotation timer while connected, the
 * Hello timeout while handshaking, and the reconnect timer otherwise. Since the alarm survives eviction and code
 * updates, an alarm that finds no socket in memory reconnects, resuming with the session saved in SQLite when it can.
 */
export default class DiscordGateway extends DurableObject<Env> {
  private readonly storage: ShardStorage;
  private socket: WebSocket | null = null;
  /** Bumped whenever a socket is dropped, so events and pending work from older sockets are ignored. */
  private connectionId = 0;
  private phase: ConnectionPhase = "idle";
  private shardId = 0;
  private sequence: number | null = null;
  private heartbeatIntervalMs: number | null = null;
  private heartbeatAcknowledged = true;
  /** While connected, the alarm is set for whichever of these comes first. */
  private nextHeartbeatAt: number | null = null;
  private nextRotationAt: number | null = null;
  private lastHeartbeatSentAt: number | null = null;
  private latencyMs: number | null = null;
  /** Dispatches waiting for their handlers, which run one at a time in the order Discord sent them. */
  private readonly pendingDispatches: GatewayDispatchPayload[] = [];
  private drainingDispatches = false;

  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new ShardStorage(ctx.storage);
    // SQL calls are synchronous, so the schema is ready before any request or alarm is delivered.
    this.storage.migrate();
  }

  /**
   * Called by the scheduled handler for every shard on each run. Stores the shard's config and starts it if nothing is
   * running or pending. Safe to call repeatedly.
   *
   * @param {ShardConfig} config - This shard's ID, the total shard count and the identify concurrency.
   * @returns {Promise<EnsureResult>} The previous shard count, and whether the shard is running.
   */
  public async ensure(config: ShardConfig): Promise<EnsureResult> {
    const previous = this.storage.get();
    const previousShardCount = previous?.shardCount ?? null;
    this.shardId = config.shardId;
    const reconfigured =
      previous !== null && (previous.shardId !== config.shardId || previous.shardCount !== config.shardCount);

    this.storage.configure(config);
    if (reconfigured) {
      log("info", `[shard ${config.shardId}] Shard config changed, starting a new session`, {
        from: [previous.shardId, previous.shardCount],
        to: [config.shardId, config.shardCount],
      });
      this.dropSocket(SESSION_ENDING_CLOSE_CODE, "Shard configuration changed");
      this.storage.clearSession();
      this.storage.clearFatal();
    }

    const state = this.storage.get();
    if (state === null) {
      throw new Error("Shard state missing after configuring");
    }
    if (state.fatalFingerprint !== null) {
      if ((await this.fingerprint(state)) === state.fatalFingerprint) {
        log("error", `[shard ${state.shardId}] Halted by close code ${state.fatalCloseCode}; fix the cause to resume`);
        return { previousShardCount, running: false };
      }
      log("info", `[shard ${state.shardId}] Token, intents or shard config changed since close code; retrying`);
      this.storage.clearFatal();
    }

    // Every phase but `connecting` should have an alarm pending; re-arm it if it is somehow missing.
    if (this.phase !== "connecting" && (await this.ctx.storage.getAlarm()) === null) {
      await (this.phase === "idle"
        ? this.scheduleAlarm(canResume(state) ? 0 : identifyDelay(state))
        : this.scheduleNextAlarm());
    }
    return { previousShardCount, running: true };
  }

  /** Ends the session and keeps the shard offline until `ensure` is called again. */
  public async stop(): Promise<void> {
    this.storage.disable();
    this.dropSocket(SESSION_ENDING_CLOSE_CODE, "Shard stopped");
    this.storage.clearSession();
    await this.ctx.storage.deleteAlarm();
    log("info", `[shard ${this.shardId}] Stopped`);
  }

  /**
   * Reports the shard's connection and session state, for debugging.
   *
   * @returns {ShardStatus} The current phase, session and heartbeat info.
   */
  public status(): ShardStatus {
    const state = this.storage.get();
    return {
      enabled: state?.enabled ?? false,
      fatalCloseCode: state?.fatalCloseCode ?? null,
      hasSession: state !== null && canResume(state),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      latencyMs: this.latencyMs,
      phase: this.phase,
      reconnectAttempts: state?.reconnectAttempts ?? 0,
      sequence: state?.sequence ?? null,
      shardCount: state?.shardCount ?? null,
      shardId: state?.shardId ?? null,
    };
  }

  public override async alarm(): Promise<void> {
    const state = this.storage.get();
    if (state === null || !state.enabled || state.fatalCloseCode !== null) {
      return;
    }
    switch (this.phase) {
      case "connecting":
        // The in-flight connection attempt schedules the next alarm when it finishes.
        break;
      case "idle":
        await this.openConnection(state);
        break;
      case "handshaking":
      case "ready":
        await this.tick(state);
        break;
      default:
        // No default
        break;
    }
  }

  /**
   * Runs whatever is due on a connected shard: the heartbeat, the hourly activity rotation, or both.
   *
   * @param {ShardState} state - The shard's state.
   */
  private async tick(state: ShardState): Promise<void> {
    if (this.heartbeatIntervalMs === null || this.nextHeartbeatAt === null) {
      log("warn", `[shard ${state.shardId}] No Hello within ${HELLO_TIMEOUT_MS}ms`);
      await this.reconnect("Hello timed out", { resume: true });
      return;
    }
    const now = Date.now();
    if (now >= this.nextHeartbeatAt) {
      if (!this.heartbeatAcknowledged) {
        log("warn", `[shard ${state.shardId}] Last heartbeat was not acknowledged; connection is zombied`);
        await this.reconnect("Heartbeat not acknowledged", { resume: true });
        return;
      }
      this.sendHeartbeat();
      this.nextHeartbeatAt = now + this.heartbeatIntervalMs;
    }
    if (this.nextRotationAt !== null && now >= this.nextRotationAt) {
      this.rotateActivity();
      this.nextRotationAt = nextTopOfHour(now);
    }
    await this.scheduleNextAlarm();
  }

  private async openConnection(state: ShardState): Promise<void> {
    this.connectionId += 1;
    const { connectionId } = this;
    this.phase = "connecting";
    this.shardId = state.shardId;
    const resuming = canResume(state);
    try {
      let url = "";
      if (resuming) {
        this.sequence = state.sequence;
        url = state.resumeGatewayUrl;
      } else {
        // Identifying always refetches Get Gateway Bot: it has the current URL and the session start limit, and
        // running out of identifies resets the bot token.
        this.sequence = null;
        const gateway = await getGatewayBot(this.env.DISCORD_APP_SECRET);
        if (connectionId !== this.connectionId) {
          return;
        }
        const limit = gateway.session_start_limit;
        if (limit.remaining <= 0) {
          log("warn", `[shard ${state.shardId}] No session starts left; waiting ${limit.reset_after}ms to identify`);
          this.phase = "idle";
          await this.scheduleAlarm(limit.reset_after);
          return;
        }
        ({ url } = gateway);
      }

      const socket = await openSocket(url);
      if (connectionId !== this.connectionId) {
        socket.accept();
        socket.close(SESSION_ENDING_CLOSE_CODE, "Superseded");
        return;
      }
      this.attach(socket, connectionId);
      log("info", `[shard ${state.shardId}] Connected; ${resuming ? "resuming" : "identifying"}`);
      await this.scheduleAlarm(HELLO_TIMEOUT_MS);
    } catch (error) {
      if (connectionId !== this.connectionId) {
        return;
      }
      this.resetConnection();
      if (isUnauthorizedError(error)) {
        await this.halt(state, GatewayCloseCodes.AuthenticationFailed);
        return;
      }
      log("error", `[shard ${state.shardId}] Failed to connect to the gateway`, error);
      await this.scheduleAlarm(reconnectDelay(this.storage.incrementReconnectAttempts()));
    }
  }

  private attach(socket: WebSocket, connectionId: number): void {
    this.socket = socket;
    this.phase = "handshaking";
    this.heartbeatIntervalMs = null;
    this.heartbeatAcknowledged = true;
    socket.addEventListener("message", (event) => {
      if (connectionId === this.connectionId) {
        const data: unknown = event.data;
        this.handleMessage(data);
      }
    });
    socket.addEventListener("close", (event) => {
      if (connectionId === this.connectionId) {
        void this.handleClose(event.code, event.reason);
      }
    });
    socket.addEventListener("error", (event) => {
      if (connectionId === this.connectionId) {
        log("error", `[shard ${this.shardId}] Gateway socket error`, event.message);
        void this.reconnect("Socket error", { resume: true });
      }
    });
    socket.accept();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      log("warn", `[shard ${this.shardId}] Ignoring non-text gateway message`);
      return;
    }
    const payload = parsePayload(data);
    if (payload === null) {
      log("warn", `[shard ${this.shardId}] Ignoring malformed gateway message`);
      return;
    }
    switch (payload.op) {
      case GatewayOpcodes.Dispatch:
        this.handleDispatchPayload(payload);
        break;
      case GatewayOpcodes.Heartbeat:
        log("info", `[shard ${this.shardId}] Discord requested a heartbeat`);
        this.sendHeartbeat();
        break;
      case GatewayOpcodes.HeartbeatAck:
        this.heartbeatAcknowledged = true;
        if (this.lastHeartbeatSentAt !== null) {
          this.latencyMs = Date.now() - this.lastHeartbeatSentAt;
        }
        log("info", `[shard ${this.shardId}] Heartbeat acknowledged`, { latencyMs: this.latencyMs });
        break;
      case GatewayOpcodes.Hello:
        log("info", `[shard ${this.shardId}] Hello`, payload.d);
        void this.handleHello(payload.d.heartbeat_interval);
        break;
      case GatewayOpcodes.Reconnect:
        log("info", `[shard ${this.shardId}] Discord requested a reconnect`);
        void this.reconnect("Reconnect requested", { resume: true });
        break;
      case GatewayOpcodes.InvalidSession:
        log("warn", `[shard ${this.shardId}] Invalid session`, { resumable: payload.d });
        void this.reconnect("Invalid session", {
          delayMs: randomBetween(INVALID_SESSION_MIN_DELAY_MS, INVALID_SESSION_MAX_DELAY_MS),
          resume: payload.d,
        });
        break;
      default:
        // No default
        break;
    }
  }

  private async handleHello(heartbeatIntervalMs: number): Promise<void> {
    const state = this.storage.get();
    if (state === null || this.socket === null) {
      return;
    }
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatAcknowledged = true;
    if (canResume(state)) {
      this.send({
        d: { seq: state.sequence, session_id: state.sessionId, token: this.env.DISCORD_APP_SECRET },
        op: GatewayOpcodes.Resume,
      });
    } else {
      this.send({
        d: {
          intents: GATEWAY_INTENTS,
          presence: toPresence(this.nextQuip()),
          properties: IDENTIFY_PROPERTIES,
          shard: [state.shardId, state.shardCount],
          token: this.env.DISCORD_APP_SECRET,
        },
        op: GatewayOpcodes.Identify,
      });
    }
    // The first heartbeat waits a random fraction of the interval, as Discord asks.
    this.nextHeartbeatAt = Date.now() + heartbeatIntervalMs * Math.random();
    await this.scheduleNextAlarm();
  }

  private handleDispatchPayload(payload: GatewayDispatchPayload): void {
    // Persist the sequence first so a Resume after eviction replays from the right place.
    this.sequence = payload.s;
    if (payload.t === GatewayDispatchEvents.Ready) {
      this.storage.saveSession(payload.d.session_id, payload.d.resume_gateway_url, payload.s);
      this.onSessionReady();
    } else {
      this.storage.saveSequence(payload.s);
      if (payload.t === GatewayDispatchEvents.Resumed) {
        this.storage.resetReconnectAttempts();
        this.onSessionReady();
      }
    }
    this.pendingDispatches.push(payload);
    void this.drainDispatches();
  }

  /** Marks the session usable and starts the hourly activity rotation; presence updates fail before Ready. */
  private onSessionReady(): void {
    this.phase = "ready";
    this.nextRotationAt = nextTopOfHour(Date.now());
    void this.scheduleNextAlarm();
  }

  /**
   * Picks the next quip and records it as shown, so the cycle carries on across evictions and deploys.
   *
   * @returns {string} The quip to show as the custom status.
   */
  private nextQuip(): string {
    const pick = pickQuip(this.storage.getShownActivities());
    this.storage.recordShownActivity(pick.key, pick.startsCycle);
    return pick.quip;
  }

  private rotateActivity(): void {
    const quip = this.nextQuip();
    this.send({ d: toPresence(quip), op: GatewayOpcodes.PresenceUpdate });
    log("info", `[shard ${this.shardId}] Rotated custom status`, { quip });
  }

  private async drainDispatches(): Promise<void> {
    if (this.drainingDispatches) {
      return;
    }
    this.drainingDispatches = true;
    const context: DispatchContext = { env: this.env, shardId: this.shardId };
    try {
      for (let payload = this.pendingDispatches.shift(); payload; payload = this.pendingDispatches.shift()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- Handlers must run in the order Discord sent the events
          await handleDispatch(payload, context);
        } catch (error) {
          log("error", `[shard ${context.shardId}] ${payload.t} handler failed`, error);
        }
      }
    } finally {
      this.drainingDispatches = false;
    }
  }

  private async handleClose(code: number, reason: string): Promise<void> {
    this.resetConnection();
    const state = this.storage.get();
    if (state === null || !state.enabled) {
      return;
    }
    log("warn", `[shard ${state.shardId}] Gateway closed the connection`, { code, reason });
    if (FATAL_CLOSE_CODES.has(code)) {
      await this.halt(state, code);
      return;
    }
    if (SESSION_INVALIDATING_CLOSE_CODES.has(code)) {
      this.storage.clearSession();
    }
    await this.scheduleAlarm(reconnectDelay(this.storage.incrementReconnectAttempts()));
  }

  /**
   * Drops the current socket and schedules a new connection.
   *
   * @param {string} reason - Close reason sent to Discord.
   * @param {object} options - Reconnect options.
   * @param {boolean} options.resume - Whether to keep the session and Resume, rather than Identify.
   * @param {number} [options.delayMs] - Minimum wait before reconnecting, on top of the backoff.
   */
  private async reconnect(reason: string, options: { resume: boolean; delayMs?: number }): Promise<void> {
    this.dropSocket(RESUMABLE_CLOSE_CODE, reason);
    if (!options.resume) {
      this.storage.clearSession();
    }
    const attempts = this.storage.incrementReconnectAttempts();
    await this.scheduleAlarm(Math.max(options.delayMs ?? 0, reconnectDelay(attempts)));
  }

  /**
   * Stops reconnecting after a non-retryable close until `ensure` sees the token, intents or shard config change.
   *
   * @param {ShardState} state - The shard's state when it closed.
   * @param {number} closeCode - The non-retryable close code.
   */
  private async halt(state: ShardState, closeCode: number): Promise<void> {
    this.storage.clearSession();
    this.storage.setFatal(closeCode, await this.fingerprint(state));
    await this.ctx.storage.deleteAlarm();
    log("error", `[shard ${state.shardId}] Halted by non-retryable close code ${closeCode}`);
  }

  private sendHeartbeat(): void {
    this.heartbeatAcknowledged = false;
    this.lastHeartbeatSentAt = Date.now();
    this.send({ d: this.sequence, op: GatewayOpcodes.Heartbeat });
  }

  private send(payload: GatewaySendPayload): void {
    if (this.socket === null) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      log("error", `[shard ${this.shardId}] Failed to send opcode ${payload.op}`, error);
      void this.reconnect("Send failed", { resume: true });
    }
  }

  /**
   * Detaches the socket before closing it: a zombied connection may never deliver its close event, and listeners for
   * the old connection must not act on the new one.
   *
   * @param {number} code - Close code to send; anything but 1000/1001 keeps the session resumable.
   * @param {string} reason - Close reason to send.
   */
  private dropSocket(code: number, reason: string): void {
    const { socket } = this;
    this.resetConnection();
    if (socket === null) {
      return;
    }
    try {
      socket.close(code, reason);
    } catch (error) {
      log("warn", `[shard ${this.shardId}] Failed to close gateway socket`, error);
    }
  }

  private resetConnection(): void {
    this.connectionId += 1;
    this.socket = null;
    this.phase = "idle";
    this.heartbeatIntervalMs = null;
    this.heartbeatAcknowledged = true;
    this.lastHeartbeatSentAt = null;
    this.nextHeartbeatAt = null;
    this.nextRotationAt = null;
  }

  /** Sets the alarm for the next heartbeat or rotation, whichever is sooner; with neither, waits for Hello. */
  private async scheduleNextAlarm(): Promise<void> {
    const dueTimes = [this.nextHeartbeatAt, this.nextRotationAt].filter((time) => time !== null);
    await this.scheduleAlarm(dueTimes.length > 0 ? Math.min(...dueTimes) - Date.now() : HELLO_TIMEOUT_MS);
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + Math.max(0, Math.round(delayMs)));
  }

  /**
   * Identifies the inputs a non-retryable close depends on, without storing the token itself.
   *
   * @param {ShardState} state - The shard's state.
   * @returns {Promise<string>} A SHA-256 hex digest of the token, intents, API version and shard config.
   */
  private async fingerprint(state: ShardState): Promise<string> {
    const input = JSON.stringify([
      this.env.DISCORD_APP_SECRET,
      GATEWAY_INTENTS,
      GatewayVersion,
      state.shardId,
      state.shardCount,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = Array.from(new Uint8Array(digest), (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_LENGTH, "0"));
    return bytes.join("");
  }
}

export type { EnsureResult, ShardConfig, ShardStatus } from "./gateway/types.ts";
