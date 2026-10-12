import assert from "node:assert/strict";
import test from "node:test";
import { WechatBurstBuffer } from "../src/wechat/burstBuffer.js";

test("groups two messages", () => {
  const output: Array<{ text: string; eventId: string }> = [];
  const buffer = new WechatBurstBuffer((item) => output.push(item), {
    quietMs: 60000,
    maxWaitMs: 60000,
  });

  buffer.add({
    eventId: "event-one",
    conversationId: "conversation-one",
    text: "one",
    receivedAt: new Date().toISOString(),
  });
  buffer.add({
    eventId: "event-two",
    conversationId: "conversation-one",
    text: "two",
    receivedAt: new Date().toISOString(),
  });

  buffer.flush("conversation-one");
  assert.equal(output.length, 1);
  assert.equal(output[0]?.text, "one\ntwo");
  assert.equal(output[0]?.eventId.startsWith("wechat-burst:"), true);
});
