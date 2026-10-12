import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEventQueue } from "../src/queue.js";
import type { BridgeEvent } from "../src/types.js";

function makeEvent(id: string): BridgeEvent {
  return {
    id,
    correlationId: id,
    kind: "message",
    source: "wechat.dm",
    stream: "conversation",
    replyRoute: "wechat.dm",
    replyPolicy: "required",
    createdAt: new Date().toISOString(),
    visibleText: "【微信】\nhello",
    modelContext: "test",
  };
}

test("completed required reply unblocks the next conversation", () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(makeEvent("e1"));
  queue.enqueue(makeEvent("e2"));

  const first = queue.reserveConversationById("e1");
  assert.equal(first.state, "reserved");
  queue.markDelivered("e1");

  const claim = queue.claimReply("e1", "fp");
  assert.equal(claim.state, "send");
  queue.markReplyMessageSent("e1", "fp");
  queue.markReplyCompleted("e1", "fp");

  assert.equal(queue.getOutstandingRequiredReplyEvent(), null);
  assert.equal(queue.peekNextConversation()?.id, "e2");
});

test("later event cannot bypass an earlier pending event", () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(makeEvent("e1"));
  queue.enqueue(makeEvent("e2"));

  const later = queue.reserveConversationById("e2");
  assert.equal(later.state, "blocked");
  assert.equal(later.blockedBy, "e1");
});
