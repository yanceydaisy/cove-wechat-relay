import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { BridgeEvent } from "../types.js";
import { sameChallenge, sign, signingKey } from "./signatures.js";
import { EventsStore, type Subscription } from "./store.js";
import { checkedDestination, postChecked } from "./urlSafety.js";

export type Post = (
  url: string,
  body: string,
  headers: Record<string, string>,
  allowLocalHttp: boolean,
) => Promise<{ status: number; body: string }>;

export class EventsError extends Error {
  constructor(
    message: string,
    public readonly code = -32602,
    public readonly reason?: string,
  ) {
    super(message);
  }
}

export const eventCatalog = [{
  name: "cove.bridge.requested",
  description: "A WeChat conversation is ready for ChatGPT to read and answer.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        enum: ["wechat.dm"],
        description: "The Cove WeChat Relay conversation source to monitor.",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      bridgeEventId: { type: "string" },
      source: { type: "string" },
      stream: { type: "string" },
      replyPolicy: { type: "string" },
      createdAt: { type: "string" },
    },
    required: ["bridgeEventId", "source", "stream", "replyPolicy", "createdAt"],
    additionalProperties: false,
  },
}];

type SubscribeParams = {
  name?: unknown;
  arguments?: unknown;
  delivery?: { mode?: unknown; url?: unknown; secret?: unknown };
  ttlMs?: unknown;
  cursor?: unknown;
};

type Identity = {
  name: "cove.bridge.requested";
  arguments: { source: "wechat.dm" };
  url: string;
};

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function parseIdentity(params: SubscribeParams): Identity {
  if (params.name !== "cove.bridge.requested") {
    throw new EventsError("The event name is not valid.");
  }
  if (params.delivery?.mode !== "webhook" || typeof params.delivery.url !== "string") {
    throw new EventsError("The webhook delivery is not valid.");
  }

  const args = params.arguments;
  if (
    !args
    || typeof args !== "object"
    || Array.isArray(args)
    || Object.keys(args).length !== 1
    || (args as Record<string, unknown>).source !== "wechat.dm"
  ) {
    throw new EventsError("The bridge event requires source=wechat.dm.");
  }

  return {
    name: "cove.bridge.requested",
    arguments: { source: "wechat.dm" },
    url: params.delivery.url,
  };
}

function subscriptionId(owner: string, identity: Identity): string {
  return `sub_${createHash("sha256")
    .update(JSON.stringify([owner, identity.url, identity.name, canonicalJson(identity.arguments)]))
    .digest("hex")
    .slice(0, 32)}`;
}

function signedHeaders(subscription: Subscription, id: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signatures = [sign(subscription.secret, id, timestamp, body)];

  if (
    subscription.previousSecret
    && subscription.rotationExpiresAt
    && subscription.rotationExpiresAt > new Date().toISOString()
  ) {
    signatures.push(sign(subscription.previousSecret, id, timestamp, body));
  }

  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": subscription.id,
  };
}

export class EventsService {
  private readonly verifiedCallbacks = new Map<string, number>();
  private readonly acceptedDeliveries = new Set<string>();

  constructor(
    private readonly store: EventsStore,
    private readonly allowLocalHttp = false,
    private readonly post: Post = postChecked,
    private readonly checkUrl = checkedDestination,
  ) {}

  list() {
    return { events: eventCatalog };
  }

  async subscribe(owner: string, params: SubscribeParams) {
    const identity = parseIdentity(params);
    if (typeof params.delivery?.secret !== "string") {
      throw new EventsError("The signing secret is not valid.");
    }
    try {
      signingKey(params.delivery.secret);
    } catch {
      throw new EventsError("The signing secret is not valid.");
    }

    if (params.cursor !== undefined && params.cursor !== null) {
      throw new EventsError("This event does not support a cursor.");
    }
    if (
      params.ttlMs !== undefined
      && params.ttlMs !== null
      && (!Number.isSafeInteger(params.ttlMs) || (params.ttlMs as number) <= 0)
    ) {
      throw new EventsError("The subscription lifetime is not valid.");
    }

    try {
      await this.checkUrl(identity.url, this.allowLocalHttp);
    } catch {
      throw new EventsError("The callback URL is not allowed.");
    }

    const id = subscriptionId(owner, identity);
    const existing = this.store.get(id);
    const maxLifetime = 24 * 60 * 60 * 1000;
    const lifetime = Math.min(
      typeof params.ttlMs === "number" ? params.ttlMs : maxLifetime,
      maxLifetime,
    );

    const subscription: Subscription = {
      ...identity,
      id,
      owner,
      secret: params.delivery.secret,
      refreshBefore: new Date(Date.now() + lifetime).toISOString(),
      active: false,
    };

    if (
      existing?.active
      && existing.secret !== subscription.secret
      && existing.refreshBefore > new Date().toISOString()
    ) {
      subscription.previousSecret = existing.secret;
      subscription.rotationExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    }

    const cacheKey = JSON.stringify([owner, identity.url, subscription.secret]);
    const alreadyVerified =
      (existing?.active
        && existing.secret === subscription.secret
        && existing.refreshBefore > new Date().toISOString())
      || (this.verifiedCallbacks.get(cacheKey) ?? 0) > Date.now();

    if (alreadyVerified) {
      subscription.active = true;
      await this.store.put(subscription);
    } else {
      await this.store.put(subscription);
      const challenge = randomBytes(32).toString("base64url");
      const messageId = `msg_verification_${randomUUID()}`;
      const body = JSON.stringify({ type: "verification", challenge });

      try {
        const response = await this.post(
          subscription.url,
          body,
          signedHeaders(subscription, messageId, body),
          this.allowLocalHttp,
        );

        let parsed: unknown = null;
        try { parsed = JSON.parse(response.body); } catch {}
        const echoed = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { challenge?: unknown }).challenge
          : undefined;

        if (response.status < 200 || response.status >= 300 || !sameChallenge(challenge, echoed)) {
          throw new EventsError(
            "The callback challenge failed.",
            -32015,
            response.status >= 200 && response.status < 300 ? "challenge_failed" : "callback_http_error",
          );
        }

        subscription.active = true;
        await this.store.put(subscription);
        this.verifiedCallbacks.set(cacheKey, Date.now() + 5 * 60_000);
        console.log(
          `MCP Events subscription active: id=${subscription.id} name=${subscription.name} refreshBefore=${subscription.refreshBefore}`,
        );
      } catch (error) {
        if (existing) await this.store.put(existing);
        else await this.store.remove(id);
        if (error instanceof EventsError) throw error;
        throw new EventsError("The callback challenge failed.", -32015, "challenge_failed");
      }
    }

    return {
      id,
      refreshBefore: subscription.refreshBefore,
      cursor: null,
      truncated: false,
    };
  }

  async unsubscribe(owner: string, params: SubscribeParams) {
    const identity = parseIdentity(params);
    const id = subscriptionId(owner, identity);
    if (this.store.get(id)?.owner === owner) await this.store.remove(id);
    return {};
  }

  async emitBridgeRequested(bridgeEvent: BridgeEvent, wakeAttempt = 0) {
    const emittedAt = new Date().toISOString();
    const event = {
      // A watchdog re-wake is a new notification for the same underlying
      // bridgeEventId. Transport retries of each notification keep this eventId.
      eventId: `evt_bridge_${createHash("sha256")
        .update(bridgeEvent.id)
        .digest("hex")
        .slice(0, 32)}_r${wakeAttempt}`,
      name: "cove.bridge.requested" as const,
      timestamp: emittedAt,
      data: {
        bridgeEventId: bridgeEvent.id,
        source: bridgeEvent.source,
        stream: bridgeEvent.stream,
        replyPolicy: bridgeEvent.replyPolicy,
        createdAt: bridgeEvent.createdAt,
      },
      cursor: null,
    };

    const matches = this.store.all().filter(
      (item) =>
        item.active
        && item.refreshBefore > new Date().toISOString()
        && item.name === "cove.bridge.requested"
        && item.arguments.source === "wechat.dm",
    );

    return await this.deliver(event, matches);
  }

  private async deliver(
    event: {
      eventId: string;
      name: "cove.bridge.requested";
      timestamp: string;
      data: Record<string, unknown>;
      cursor: null;
    },
    matches: Subscription[],
  ) {
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body, "utf8") > 256 * 1024) {
      throw new Error("Event payload exceeds 256 KiB.");
    }

    const deliveries = await Promise.all(matches.map(async (subscription) => {
      const deliveryKey = `${subscription.id}:${event.eventId}`;
      if (this.acceptedDeliveries.has(deliveryKey)) {
        return {
          subscriptionId: subscription.id,
          accepted: true,
          status: 208,
          deduplicated: true,
        };
      }

      let lastStatus = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.post(
            subscription.url,
            body,
            signedHeaders(subscription, event.eventId, body),
            this.allowLocalHttp,
          );
          lastStatus = response.status;
          if (response.status >= 200 && response.status < 300) {
            this.acceptedDeliveries.add(deliveryKey);
            return {
              subscriptionId: subscription.id,
              accepted: true,
              status: response.status,
              deduplicated: false,
            };
          }
          if (
            response.status === 410
            || response.status === 413
            || (response.status >= 400 && response.status < 500 && response.status !== 429)
          ) {
            break;
          }
        } catch {
          lastStatus = 0;
        }

        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
        }
      }

      return {
        subscriptionId: subscription.id,
        accepted: false,
        status: lastStatus,
        deduplicated: false,
      };
    }));

    return { event, subscriptions: matches.length, deliveries };
  }
}
