import { createHash } from "node:crypto";
import type { InMemoryEventQueue } from "./queue.js";
import { normalizeReplyBubbles } from "./replyBubbles.js";
import type { WechatRelayStore } from "./wechat/relayStore.js";

export type BridgeReplyResult = {
  ok: true;
  eventId: string;
  route: "wechat.dm";
  sentCount: number;
  completed: boolean;
  deduplicated: boolean;
  text: string;
};

export async function deliverBridgeReply(
  queue: InMemoryEventQueue,
  wechatRelay: WechatRelayStore,
  input: { eventId: string; messages: string[] },
  onCompleted?: () => void | Promise<void>,
): Promise<BridgeReplyResult> {
  const outstanding = queue.getOutstandingRequiredReplyEvent();
  const requested = queue.getEvent(input.eventId);
  const event = outstanding ?? requested;
  if (!event) throw new Error(`Unknown Cove Bridge event: ${input.eventId}`);

  const resolvedEventId = event.id;
  if (input.eventId !== resolvedEventId) {
    throw new Error(`Another required reply is still pending: ${resolvedEventId}`);
  }

  const normalized = normalizeReplyBubbles(input.messages);
  if (normalized.length === 0) throw new Error("Reply must contain at least one non-empty message.");

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      eventId: resolvedEventId,
      route: event.replyRoute,
      messages: normalized,
    }))
    .digest("hex");
  const claim = queue.claimReply(resolvedEventId, fingerprint);

  if (claim.state === "already_completed" || claim.state === "in_progress") {
    return {
      ok: true,
      eventId: resolvedEventId,
      route: "wechat.dm",
      sentCount: claim.sentCount,
      completed: claim.state === "already_completed",
      deduplicated: true,
      text: claim.state === "already_completed"
        ? "Reply was already delivered; duplicate send suppressed."
        : "The same reply is already being delivered; duplicate send suppressed.",
    };
  }

  let sentCount = claim.sentCount;
  try {
    for (let index = sentCount; index < normalized.length; index += 1) {
      const delivery = await wechatRelay.requestDelivery(
        resolvedEventId,
        index,
        normalized[index]!,
        12_000,
      );
      if (!delivery.ok) {
        throw new Error(delivery.error || `WeChat delivery failed: ${resolvedEventId}#${index}`);
      }
      sentCount = queue.markReplyMessageSent(resolvedEventId, fingerprint);
    }

    queue.markReplyCompleted(resolvedEventId, fingerprint);
    wechatRelay.forgetEvent(resolvedEventId);
    await onCompleted?.();

    return {
      ok: true,
      eventId: resolvedEventId,
      route: "wechat.dm",
      sentCount,
      completed: true,
      deduplicated: false,
      text: `Delivered ${sentCount} chat bubble(s) through WeChat.`,
    };
  } catch (error) {
    console.warn(
      `Cove WeChat reply deferred: eventId=${resolvedEventId} sent=${sentCount}/${normalized.length}`,
      error instanceof Error ? error.message : error,
    );

    void (async () => {
      let nextIndex = sentCount;
      while (nextIndex < normalized.length) {
        try {
          const delivery = await wechatRelay.requestDelivery(
            resolvedEventId,
            nextIndex,
            normalized[nextIndex]!,
            45_000,
          );
          if (!delivery.ok) {
            throw new Error(delivery.error || `WeChat delivery failed: ${resolvedEventId}#${nextIndex}`);
          }
          sentCount = queue.markReplyMessageSent(resolvedEventId, fingerprint);
          nextIndex = sentCount;
        } catch (backgroundError) {
          console.warn(
            `Cove WeChat background retry: eventId=${resolvedEventId} index=${nextIndex}`,
            backgroundError instanceof Error ? backgroundError.message : backgroundError,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
        }
      }

      queue.markReplyCompleted(resolvedEventId, fingerprint);
      wechatRelay.forgetEvent(resolvedEventId);
      await onCompleted?.();
      console.log(
        `Cove WeChat reply delivered in background: eventId=${resolvedEventId} messages=${normalized.length}`,
      );
    })();

    return {
      ok: true,
      eventId: resolvedEventId,
      route: "wechat.dm",
      sentCount,
      completed: false,
      deduplicated: false,
      text: `WeChat reply accepted; ${sentCount}/${normalized.length} bubble(s) confirmed and the remainder will keep retrying in the background.`,
    };
  }
}
