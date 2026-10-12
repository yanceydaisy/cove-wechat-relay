import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import test from "node:test";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForReady(child: ChildProcess): Promise<void> {
  if (!child.stdout) throw new Error("bridge stdout is unavailable");
  const stdout = child.stdout;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bridge start timed out")), 8000);
    const onData = (data: Buffer) => {
      if (data.toString("utf8").includes("Bridge listening")) {
        clearTimeout(timeout);
        stdout.off("data", onData);
        resolve();
      }
    };
    stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`bridge exited early: ${code}`));
    });
  });
}

test("standalone bridge serves Windows and MCP surfaces", async () => {
  const port = await freePort();
  const agentToken = ["test", "agent", "token", "123456789"].join("-");
  const eventsToken = ["test", "events", "path", "123456789"].join("-");

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        WECHAT_AGENT_TOKEN: agentToken,
        MCP_EVENTS_PATH_TOKEN: eventsToken,
        MCP_EVENTS_STORE_PATH: `.local/test-${port}-subscriptions.json`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForReady(child);
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);

    const heartbeat = await fetch(`${base}/wechat/agent/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(heartbeat.status, 200);

    const inbound = await fetch(`${base}/wechat/agent/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "smoke-event-one",
        conversationId: "smoke-conversation",
        text: "hello",
      }),
    });
    assert.equal(inbound.status, 202);
    const inboundBody = await inbound.json() as { created: boolean; buffered: boolean };
    assert.equal(inboundBody.created, true);
    assert.equal(inboundBody.buffered, true);

    const discoverBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };

    const discover = await fetch(`${base}/mcp/events/${eventsToken}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify(discoverBody),
    });
    assert.equal(discover.status, 200);
    const rpc = await discover.json() as {
      result?: { capabilities?: { events?: unknown; tools?: unknown } };
    };
    assert.ok(rpc.result?.capabilities?.events);
    assert.ok(rpc.result?.capabilities?.tools);
  } finally {
    child.kill();
  }
});
