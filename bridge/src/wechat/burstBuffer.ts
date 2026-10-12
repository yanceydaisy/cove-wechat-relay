import { createHash } from "node:crypto";

export type WechatBurstMessage = {
  eventId: string;
  conversationId: string;
  text: string;
  receivedAt: string;
};

export type WechatBurst = {
  eventId: string;
  conversationId: string;
  messages: WechatBurstMessage[];
  text: string;
  additionalModelContext: string;
};

type PendingBurst = {
  conversationId: string;
  messages: WechatBurstMessage[];
  quietTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
};

export type WechatBurstBufferOptions = {
  quietMs?: number;
  maxWaitMs?: number;
  maxMessages?: number;
  seenLimit?: number;
};

const DEFAULT_QUIET_MS = 4_000;
const DEFAULT_MAX_WAIT_MS = 8_000;
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_SEEN_LIMIT = 4_000;

export class WechatBurstBuffer {
  private readonly pending = new Map<string, PendingBurst>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly maxMessages: number;
  private readonly seenLimit: number;

  constructor(
    private readonly onFlush: (burst: WechatBurst) => void,
    options: WechatBurstBufferOptions = {},
  ) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.seenLimit = options.seenLimit ?? DEFAULT_SEEN_LIMIT;
  }

  add(message: WechatBurstMessage): { accepted: boolean; buffered: boolean } {
    if (this.seen.has(message.eventId)) return { accepted: false, buffered: false };
    this.rememberSeen(message.eventId);

    let burst = this.pending.get(message.conversationId);
    if (!burst) {
      burst = {
        conversationId: message.conversationId,
        messages: [],
        quietTimer: null,
        maxTimer: null,
      };
      this.pending.set(message.conversationId, burst);
      burst.maxTimer = setTimeout(() => this.flush(message.conversationId), this.maxWaitMs);
      burst.maxTimer.unref?.();
    }

    burst.messages.push(message);
    if (burst.quietTimer) clearTimeout(burst.quietTimer);

    if (burst.messages.length >= this.maxMessages) {
      this.flush(message.conversationId);
      return { accepted: true, buffered: false };
    }

    burst.quietTimer = setTimeout(() => this.flush(message.conversationId), this.quietMs);
    burst.quietTimer.unref?.();
    return { accepted: true, buffered: true };
  }

  flush(conversationId: string): void {
    const burst = this.pending.get(conversationId);
    if (!burst || burst.messages.length === 0) return;
    this.pending.delete(conversationId);
    if (burst.quietTimer) clearTimeout(burst.quietTimer);
    if (burst.maxTimer) clearTimeout(burst.maxTimer);
    this.onFlush(this.buildBurst(burst));
  }

  status() {
    let messages = 0;
    for (const burst of this.pending.values()) messages += burst.messages.length;
    return {
      conversations: this.pending.size,
      messages,
      quietMs: this.quietMs,
      maxWaitMs: this.maxWaitMs,
      maxMessages: this.maxMessages,
    };
  }

  private buildBurst(burst: PendingBurst): WechatBurst {
    const ids = burst.messages.map((message) => message.eventId);
    const digest = createHash("sha256").update(ids.join("\0")).digest("hex").slice(0, 24);
    const eventId = `wechat-burst:${digest}`;
    const text = burst.messages.length === 1
      ? burst.messages[0]!.text
      : burst.messages.map((message) => message.text).join("\n");

    return {
      eventId,
      conversationId: burst.conversationId,
      messages: burst.messages,
      text,
      additionalModelContext: [
        "WECHAT DM BURST: one or more consecutive direct messages were grouped into one foreground user turn.",
        "Read the whole burst before answering. Reply naturally to the combined meaning.",
        "The number of reply bubbles is independent of the number of incoming messages.",
        `wechatConversationId=${burst.conversationId}`,
        `wechatBurstSize=${burst.messages.length}`,
        `wechatMemberEventIds=${JSON.stringify(ids)}`,
      ].join("\n"),
    };
  }

  private rememberSeen(eventId: string): void {
    this.seen.add(eventId);
    this.seenOrder.push(eventId);
    while (this.seenOrder.length > this.seenLimit) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }
}
