import assert from "node:assert/strict";
import test from "node:test";
import { WechatRelayStore } from "../src/wechat/relayStore.js";

test("delivery completes only after adapter acknowledgement", async () => {
  const relay = new WechatRelayStore();
  relay.registerInbound("event-one", "conversation-one");

  const pending = relay.requestDelivery("event-one", 0, "hello", 5000);
  const command = await relay.takeNext(20);

  assert.ok(command);
  assert.equal(command.eventId, "event-one");
  assert.equal(command.conversationId, "conversation-one");
  assert.equal(command.text, "hello");

  assert.equal(relay.complete(command.id, { ok: true }), true);
  assert.deepEqual(await pending, { ok: true });

  const duplicate = await relay.requestDelivery("event-one", 0, "hello", 5000);
  assert.deepEqual(duplicate, { ok: true });
});
