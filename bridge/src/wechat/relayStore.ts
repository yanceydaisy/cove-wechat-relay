import { createHash } from "node:crypto";

export type WechatOutboundCommand = {
  id: string;
  eventId: string;
  conversationId: string;
  index: number;
  text: string;
  createdAt: string;
};

export type WechatCommandResult = {
  ok: boolean;
  error?: string;
};

type Completed = { eventId: string; result: WechatCommandResult };

type Inflight = {
  command: WechatOutboundCommand;
  promise: Promise<WechatCommandResult>;
  resolve: (value: WechatCommandResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  retryTimer: NodeJS.Timeout;
};

const RETRY_EVERY_MS = 8_000;
const COMPLETED_LIMIT = 1_000;

function commandId(eventId: string, index: number, text: string): string {
  const digest = createHash("sha256")
    .update(eventId)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 32);
  return `wechat-${digest}`;
}

export class WechatRelayStore {
  private readonly inboundConversation = new Map<string, string>();
  private readonly pending: WechatOutboundCommand[] = [];
  private readonly inflight = new Map<string, Inflight>();
  private readonly completed = new Map<string, Completed>();
  private readonly knownCommands = new Map<string, WechatOutboundCommand>();
  private readonly waiters = new Set<() => void>();
  private lastSeenMs: number | null = null;

  registerInbound(eventId: string, conversationId: string): void {
    this.inboundConversation.set(eventId, conversationId);
  }

  markSeen(): void {
    this.lastSeenMs = Date.now();
  }

  status(now = Date.now()) {
    return {
      online: this.lastSeenMs !== null && now - this.lastSeenMs < 45_000,
      lastSeenAt: this.lastSeenMs ? new Date(this.lastSeenMs).toISOString() : null,
      pending: this.pending.length,
      inflight: this.inflight.size,
      inbound: this.inboundConversation.size,
      completedReceipts: this.completed.size,
    };
  }

  async requestDelivery(
    eventId: string,
    index: number,
    text: string,
    timeoutMs = 45_000,
  ): Promise<WechatCommandResult> {
    const conversationId = this.inboundConversation.get(eventId);
    if (!conversationId) throw new Error(`Unknown WeChat conversation for event: ${eventId}`);

    const id = commandId(eventId, index, text);
    const receipt = this.completed.get(id);
    if (receipt) return receipt.result;

    const existing = this.inflight.get(id);
    if (existing) return await existing.promise;

    const command = this.knownCommands.get(id) ?? {
      id,
      eventId,
      conversationId,
      index,
      text,
      createdAt: new Date().toISOString(),
    };
    this.knownCommands.set(id, command);

    let resolveDelivery!: (value: WechatCommandResult) => void;
    let rejectDelivery!: (reason: Error) => void;
    const promise = new Promise<WechatCommandResult>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });

    const timer = setTimeout(() => {
      const entry = this.inflight.get(id);
      if (!entry) return;
      clearInterval(entry.retryTimer);
      this.inflight.delete(id);
      this.removePending(id);
      entry.reject(new Error(`WeChat delivery timed out: ${eventId}#${index}`));
    }, timeoutMs);
    timer.unref?.();

    const retryTimer = setInterval(() => {
      if (!this.inflight.has(id)) return;
      this.enqueueIfMissing(command);
    }, Math.min(RETRY_EVERY_MS, Math.max(1_000, Math.floor(timeoutMs / 3))));
    retryTimer.unref?.();

    this.inflight.set(id, {
      command,
      promise,
      resolve: resolveDelivery,
      reject: rejectDelivery,
      timer,
      retryTimer,
    });
    this.enqueueIfMissing(command);
    return await promise;
  }

  async takeNext(waitMs = 5_000): Promise<WechatOutboundCommand | null> {
    this.markSeen();
    const immediate = this.pending.shift();
    if (immediate) return immediate;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      this.waiters.add(done);
    });

    this.markSeen();
    return this.pending.shift() ?? null;
  }

  complete(commandId: string, result: WechatCommandResult): boolean {
    this.markSeen();
    const entry = this.inflight.get(commandId);
    const eventId = entry?.command.eventId
      ?? this.knownCommands.get(commandId)?.eventId
      ?? this.completed.get(commandId)?.eventId
      ?? "";

    if (eventId && result.ok) this.rememberCompleted(commandId, eventId, result);
    else this.completed.delete(commandId);
    this.removePending(commandId);

    if (!entry) return Boolean(eventId);
    clearTimeout(entry.timer);
    clearInterval(entry.retryTimer);
    this.inflight.delete(commandId);
    entry.resolve(result);
    return true;
  }

  forgetEvent(eventId: string): void {
    this.inboundConversation.delete(eventId);
    for (const [id, entry] of this.completed) {
      if (entry.eventId === eventId) this.completed.delete(id);
    }
    for (const [id, command] of this.knownCommands) {
      if (command.eventId === eventId) this.knownCommands.delete(id);
    }
  }

  private enqueueIfMissing(command: WechatOutboundCommand): void {
    if (this.pending.some((item) => item.id === command.id)) return;
    this.pending.push(command);
    for (const wake of [...this.waiters]) wake();
  }

  private removePending(commandId: string): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index]?.id === commandId) this.pending.splice(index, 1);
    }
  }

  private rememberCompleted(commandId: string, eventId: string, result: WechatCommandResult): void {
    this.completed.delete(commandId);
    this.completed.set(commandId, { eventId, result });
    while (this.completed.size > COMPLETED_LIMIT) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }
}
