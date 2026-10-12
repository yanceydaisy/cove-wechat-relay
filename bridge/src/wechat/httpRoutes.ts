import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { WechatBurstBuffer } from "./burstBuffer.js";
import type { WechatRelayStore } from "./relayStore.js";

export type WechatEventSink = (
  eventId: string,
  conversationId: string,
  text: string,
  additionalModelContext: string,
) => void;

const eventInput = z.object({
  eventId: z.string().trim().min(1).max(200),
  conversationId: z.string().trim().min(1).max(240),
  text: z.string().trim().min(1).max(4000),
});

const resultInput = z.object({
  commandId: z.string().trim().min(1).max(200),
  ok: z.boolean(),
  error: z.string().trim().max(1000).optional(),
});

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function authorized(req: IncomingMessage, token: string): boolean {
  return Boolean(token) && req.headers.authorization === `Bearer ${token}`;
}

export async function handleWechatHttpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  relay: WechatRelayStore,
  burstBuffer: WechatBurstBuffer,
  token: string,
): Promise<boolean> {
  if (!url.pathname.startsWith("/wechat/agent/")) return false;

  if (!authorized(req, token)) {
    writeJson(res, 404, { error: "not_found" });
    return true;
  }

  try {
    if (req.method === "POST" && url.pathname === "/wechat/agent/events") {
      const parsed = eventInput.safeParse(await readJson(req));
      if (!parsed.success) {
        writeJson(res, 400, { error: parsed.error.flatten() });
        return true;
      }

      relay.markSeen();
      const result = burstBuffer.add({
        ...parsed.data,
        receivedAt: new Date().toISOString(),
      });
      writeJson(res, result.accepted ? 202 : 200, {
        ok: true,
        created: result.accepted,
        buffered: result.buffered,
        eventId: parsed.data.eventId,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/wechat/agent/next") {
      const command = await relay.takeNext();
      writeJson(res, 200, { command });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/wechat/agent/heartbeat") {
      relay.markSeen();
      writeJson(res, 200, { ok: true, status: relay.status() });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/wechat/agent/result") {
      const parsed = resultInput.safeParse(await readJson(req));
      if (!parsed.success) {
        writeJson(res, 400, { error: parsed.error.flatten() });
        return true;
      }

      const accepted = relay.complete(parsed.data.commandId, {
        ok: parsed.data.ok,
        ...(parsed.data.error ? { error: parsed.data.error } : {}),
      });

      const staleSuccess = !accepted && parsed.data.ok;
      writeJson(res, accepted || staleSuccess ? 200 : 404, {
        ok: accepted || staleSuccess,
        ...(staleSuccess ? { stale: true } : {}),
      });
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_request";
    writeJson(res, message === "request_too_large" ? 413 : 400, { error: message });
    return true;
  }
}
