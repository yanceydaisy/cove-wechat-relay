import type { BridgeEvent, StoredBridgeEvent } from "./types.js";

export type ReplyClaim =
  | { state: "send"; sentCount: number }
  | { state: "in_progress"; sentCount: number }
  | { state: "already_completed"; sentCount: number };

const REQUIRED_REPLY_REDELIVER_MS = 90_000;

export class InMemoryEventQueue {
  private readonly rows = new Map<string, StoredBridgeEvent>();
  private readonly deliveredAtMs = new Map<string, number>();
  private readonly deliveryAttempts = new Map<string, number>();
  private readonly wakeReadAtMs = new Map<string, number>();

  enqueue(event: BridgeEvent): boolean {
    if (this.rows.has(event.id)) return false;
    this.rows.set(event.id, { event, status: "pending" });
    return true;
  }

  getEvent(eventId: string): BridgeEvent | null {
    return this.rows.get(eventId)?.event ?? null;
  }

  getOutstandingRequiredReplyEvent(now = Date.now()): BridgeEvent | null {
    for (const [eventId, row] of this.rows) {
      if (this.normalizeCompletedRequiredReply(row)) continue;

      if (row.status === "delivered" && !row.reply) {
        const deliveredAt = this.deliveredAtMs.get(eventId);
        if (deliveredAt !== undefined && now - deliveredAt >= REQUIRED_REPLY_REDELIVER_MS) {
          row.status = "pending";
          this.deliveredAtMs.delete(eventId);
          continue;
        }
      }

      if (row.status === "reserved" || row.status === "delivered") return row.event;
    }
    return null;
  }

  peekNextConversation(): BridgeEvent | null {
    if (this.getOutstandingRequiredReplyEvent()) return null;
    for (const row of this.rows.values()) {
      if (row.status === "pending") return row.event;
    }
    return null;
  }

  reserveConversationById(eventId: string): {
    event: BridgeEvent | null;
    state: "reserved" | "outstanding" | "completed" | "blocked" | "missing";
    blockedBy?: string;
  } {
    const outstanding = this.getOutstandingRequiredReplyEvent();
    if (outstanding) {
      if (outstanding.id === eventId) return { event: outstanding, state: "outstanding" };
      return { event: null, state: "blocked", blockedBy: outstanding.id };
    }

    for (const [pendingId, row] of this.rows) {
      if (row.status !== "pending") continue;
      if (pendingId !== eventId) {
        return { event: null, state: "blocked", blockedBy: pendingId };
      }
      row.status = "reserved";
      this.deliveryAttempts.set(pendingId, (this.deliveryAttempts.get(pendingId) ?? 0) + 1);
      return { event: row.event, state: "reserved" };
    }

    const row = this.rows.get(eventId);
    if (!row) return { event: null, state: "missing" };
    if (row.reply?.completed) return { event: row.event, state: "completed" };
    return { event: null, state: "missing" };
  }

  markDelivered(eventId: string, now = Date.now()): void {
    const row = this.rows.get(eventId);
    if (!row) throw new Error(`Unknown event: ${eventId}`);
    if (row.status === "delivered") return;
    if (row.status !== "reserved") throw new Error(`Event is not reserved: ${eventId}`);
    row.status = "delivered";
    this.deliveredAtMs.set(eventId, now);
    this.wakeReadAtMs.set(eventId, now);
  }

  getDeliveryAttempt(eventId: string): number {
    return this.deliveryAttempts.get(eventId) ?? 0;
  }

  getWakeReadAtMs(eventId: string): number | undefined {
    return this.wakeReadAtMs.get(eventId);
  }

  hasReplyStarted(eventId: string): boolean {
    return Boolean(this.rows.get(eventId)?.reply);
  }

  claimReply(eventId: string, fingerprint: string): ReplyClaim {
    const row = this.rows.get(eventId);
    if (!row) throw new Error(`Unknown event: ${eventId}`);
    const reply = row.reply;

    if (!reply) {
      row.reply = {
        fingerprint,
        sentCount: 0,
        completed: false,
        inFlight: true,
      };
      return { state: "send", sentCount: 0 };
    }

    if (reply.completed) return { state: "already_completed", sentCount: reply.sentCount };
    if (reply.fingerprint !== fingerprint) {
      throw new Error(`Event already has a different reply: ${eventId}`);
    }
    if (reply.inFlight) return { state: "in_progress", sentCount: reply.sentCount };

    reply.inFlight = true;
    return { state: "send", sentCount: reply.sentCount };
  }

  markReplyMessageSent(eventId: string, fingerprint: string): number {
    const row = this.rows.get(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint) {
      throw new Error(`Reply is not claimed: ${eventId}`);
    }
    row.reply.sentCount += 1;
    return row.reply.sentCount;
  }

  markReplyCompleted(eventId: string, fingerprint: string): void {
    const row = this.rows.get(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint) {
      throw new Error(`Reply is not claimed: ${eventId}`);
    }
    row.reply.completed = true;
    row.reply.inFlight = false;
    row.reply.completedAt = new Date().toISOString();
    row.status = "delivered";
    this.deliveredAtMs.delete(eventId);
  }

  releaseReply(eventId: string, fingerprint: string): void {
    const row = this.rows.get(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint || row.reply.completed) return;
    row.reply.inFlight = false;
  }

  status() {
    let pending = 0;
    let reserved = 0;
    let delivered = 0;
    for (const row of this.rows.values()) {
      if (row.status === "pending") pending += 1;
      else if (row.status === "reserved") reserved += 1;
      else delivered += 1;
    }
    return { pending, reserved, delivered, total: this.rows.size };
  }

  private normalizeCompletedRequiredReply(row: StoredBridgeEvent): boolean {
    if (!row.reply?.completed) return false;
    row.status = "delivered";
    return true;
  }
}
