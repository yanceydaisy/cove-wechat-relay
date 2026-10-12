import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventsService } from "../src/events/events.js";
import { EventsStore } from "../src/events/store.js";
import type { BridgeEvent } from "../src/types.js";

test("subscription verification and bridge wake delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cove-events-"));
  try {
    const store = new EventsStore(join(dir, "subscriptions.json"));
    await store.load();

    const delivered: string[] = [];
    const post = async (_url: string, body: string) => {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === "verification") {
        return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
      }
      delivered.push(body);
      return { status: 202, body: "" };
    };

    const checkUrl = async (raw: string) => ({
      url: new URL(raw),
      address: "203.0.113.10",
      localDemo: false,
    });

    const service = new EventsService(store, false, post, checkUrl);
    const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");

    const subscription = await service.subscribe("owner", {
      name: "cove.bridge.requested",
      arguments: { source: "wechat.dm" },
      delivery: {
        mode: "webhook",
        url: "https://callback.example.test/events",
        secret,
      },
    });

    assert.equal(typeof subscription.id, "string");
    assert.equal(service.list().events.length, 1);

    const event: BridgeEvent = {
      id: "bridge-event-one",
      correlationId: "bridge-event-one",
      kind: "message",
      source: "wechat.dm",
      stream: "conversation",
      replyRoute: "wechat.dm",
      replyPolicy: "required",
      createdAt: new Date().toISOString(),
      visibleText: "hello",
      modelContext: "context",
    };

    const result = await service.emitBridgeRequested(event, 0);
    assert.equal(result.subscriptions, 1);
    assert.equal(result.deliveries[0]?.accepted, true);
    assert.equal(delivered.length, 1);

    const payload = JSON.parse(delivered[0]!) as { data: { bridgeEventId: string } };
    assert.equal(payload.data.bridgeEventId, "bridge-event-one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
