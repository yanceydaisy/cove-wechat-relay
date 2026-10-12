import type { BridgeEvent } from "../types.js";
import type { InMemoryEventQueue } from "../queue.js";

type WakeResult = {
  subscriptions: number;
  deliveries: Array<{ accepted: boolean }>;
};

type WakeState = {
  bridgeEventId: string;
  attempts: number;
  nextAtMs: number;
};

export class BridgeWakeWatchdog {
  private current: WakeState | null = null;
  private sending = false;

  constructor(
    private readonly queue: InMemoryEventQueue,
    private readonly emit: (event: BridgeEvent, attempt: number) => Promise<WakeResult>,
    private readonly log: (message: string) => void = console.log,
  ) {}

  async tick(now = Date.now()): Promise<void> {
    if (this.sending) return;

    const outstanding = this.queue.getOutstandingRequiredReplyEvent(now);
    const event = outstanding ?? this.queue.peekNextConversation();
    if (!event) {
      this.current = null;
      return;
    }

    if (!this.current || this.current.bridgeEventId !== event.id) {
      this.current = { bridgeEventId: event.id, attempts: 0, nextAtMs: 0 };
    }

    if (this.queue.hasReplyStarted(event.id)) return;
    if (now < this.current.nextAtMs) return;

    const readAt = this.queue.getWakeReadAtMs(event.id);
    if (readAt !== undefined && now - readAt < 120_000) {
      this.current.nextAtMs = Math.max(this.current.nextAtMs, readAt + 120_000);
      return;
    }

    const attempt = this.current.attempts++;
    const delayMs = attempt === 0 ? 40_000
      : attempt === 1 ? 60_000
      : attempt === 2 ? 120_000
      : 300_000;
    this.current.nextAtMs = now + delayMs;
    this.sending = true;

    try {
      const result = await this.emit(event, attempt);
      const accepted = result.deliveries.filter((delivery) => delivery.accepted).length;
      this.log(
        `MCP Event wake attempt: bridgeEventId=${event.id} source=${event.source} attempt=${attempt} subscriptions=${result.subscriptions} accepted=${accepted} completed=false`,
      );
    } catch (error) {
      this.log(
        `MCP Event wake attempt failed: bridgeEventId=${event.id} source=${event.source} attempt=${attempt} errorClass=${error instanceof Error ? error.name : "unknown"}`,
      );
    } finally {
      this.sending = false;
    }
  }

  status() {
    return this.current
      ? { pending: true, attempts: this.current.attempts, nextAtMs: this.current.nextAtMs }
      : { pending: false, attempts: 0, nextAtMs: null };
  }
}
