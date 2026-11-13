import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeTest from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_RELAY_LIMITS, RelayHub } from "../dist/relay/relay.hub.js";

const token = (name) => `gdt_${name.padEnd(43, "x")}`;

async function withRelay(devices, run, limits = {}, trustedProxyHops = 0) {
  const revoked = new Set();
  const counted = [];
  const logs = [];
  let budgetLeft = true;
  const hub = new RelayHub(
    {
      authenticate: async (value) => devices[value],
      stillUsable: async (ids) => new Set(ids.filter((id) => !revoked.has(id))),
      mayOpen: () => budgetLeft,
      countBytes: (userId, bytes) => counted.push([userId, bytes]),
      log: (event) => logs.push(event),
    },
    { ...DEFAULT_RELAY_LIMITS, heartbeatMs: 60_000, ...limits },
    trustedProxyHops,
  );
  const server = NodeHttp.createServer();
  server.on("upgrade", (request, socket, head) => {
    if (!hub.handleUpgrade(request, socket, head)) socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  const url = `ws://127.0.0.1:${server.address().port}/v1/relay`;
  const sockets = [];
  const connect = async (name, role, headers = {}) => {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    const inbox = messages(socket);
    await NodeEvents.once(socket, "open");
    socket.send(JSON.stringify({ type: "hello", token: token(name), role }));
    return { socket, inbox, first: await inbox.next() };
  };
  try {
    await run({
      connect,
      url,
      logs,
      hub,
      counted,
      revoke: (id) => revoked.add(id),
      exhaustBudget: () => {
        budgetLeft = false;
      },
      sweep: () => hub["sweep"](),
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    hub.close();
    server.close();
  }
}

/** Every message a socket receives, in order: JSON objects, or Buffers for binary frames. */
function messages(socket) {
  const queue = [];
  const waiters = [];
  const push = (item) => {
    const waiter = waiters.shift();
    if (waiter) waiter(item);
    else queue.push(item);
  };
  socket.on("message", (data, isBinary) => push(isBinary ? data : JSON.parse(data.toString())));
  socket.on("close", (code) => push({ closed: code }));
  return {
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => waiters.push(resolve)),
  };
}

const frame = (channel, text) => {
  const body = Buffer.from(text);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(channel, 0);
  body.copy(out, 4);
  return out;
};

const devices = {
  [token("laptop")]: { id: "laptop", userId: "alice", kind: "computer" },
  [token("pixel")]: { id: "pixel", userId: "alice", kind: "phone" },
  [token("bobpc")]: { id: "bobpc", userId: "bob", kind: "computer" },
  [token("bobphone")]: { id: "bobphone", userId: "bob", kind: "phone" },
};

NodeTest.test(
  "pairs a client channel with its own user's host and copies frames both ways",
  async () => {
    await withRelay(devices, async ({ connect, counted }) => {
      const host = await connect("laptop", "host");
      NodeAssert.deepEqual(host.first, { type: "ready", deviceId: "laptop" });
      const client = await connect("pixel", "client");
      NodeAssert.deepEqual(client.first, { type: "ready", deviceId: "pixel" });

      client.socket.send(JSON.stringify({ type: "ping" }));
      NodeAssert.deepEqual(await client.inbox.next(), { type: "pong" });

      client.socket.send(JSON.stringify({ type: "open", channel: 5, hostDeviceId: "laptop" }));
      const opened = await host.inbox.next();
      NodeAssert.equal(opened.type, "open");
      NodeAssert.equal(opened.clientDeviceId, "pixel");

      client.socket.send(frame(5, "hello host"));
      const atHost = await host.inbox.next();
      NodeAssert.equal(atHost.readUInt32BE(0), opened.channel);
      NodeAssert.equal(atHost.subarray(4).toString(), "hello host");

      host.socket.send(frame(opened.channel, "hello phone"));
      const atClient = await client.inbox.next();
      NodeAssert.equal(atClient.readUInt32BE(0), 5);
      NodeAssert.equal(atClient.subarray(4).toString(), "hello phone");
      NodeAssert.deepEqual(
        counted.map(([user]) => user),
        ["alice", "alice"],
      );

      client.socket.send(JSON.stringify({ type: "close", channel: 5 }));
      NodeAssert.deepEqual(await host.inbox.next(), {
        type: "close",
        channel: opened.channel,
        reason: "peer_closed",
      });
    });
  },
);

NodeTest.test("another user's computer looks offline, and phones cannot be hosts", async () => {
  await withRelay(devices, async ({ connect }) => {
    await connect("bobpc", "host");
    const client = await connect("pixel", "client");
    client.socket.send(JSON.stringify({ type: "open", channel: 1, hostDeviceId: "bobpc" }));
    NodeAssert.deepEqual(await client.inbox.next(), {
      type: "close",
      channel: 1,
      reason: "host_offline",
    });
    client.socket.send(JSON.stringify({ type: "open", channel: 2, hostDeviceId: "laptop" }));
    NodeAssert.deepEqual(await client.inbox.next(), {
      type: "close",
      channel: 2,
      reason: "host_offline",
    });

    const phoneAsHost = await connect("bobphone", "host");
    NodeAssert.deepEqual(phoneAsHost.first, { type: "error", code: "not_a_computer" });
    NodeAssert.deepEqual(await phoneAsHost.inbox.next(), { closed: 4403 });
  });
});

NodeTest.test("rejects unknown tokens and frames on channels that were never opened", async () => {
  await withRelay(devices, async ({ connect }) => {
    const stranger = await connect("nobody", "client");
    NodeAssert.deepEqual(stranger.first, { type: "error", code: "unauthorized" });

    await connect("laptop", "host");
    const client = await connect("pixel", "client");
    client.socket.send(frame(9, "nowhere"));
    NodeAssert.deepEqual(await client.inbox.next(), {
      type: "close",
      channel: 9,
      reason: "not_found",
    });
  });
});

NodeTest.test(
  "a host that disconnects closes its clients' channels; a reconnect replaces it",
  async () => {
    await withRelay(devices, async ({ connect, hub }) => {
      const first = await connect("laptop", "host");
      const second = await connect("laptop", "host");
      NodeAssert.deepEqual(await first.inbox.next(), { closed: 4409 });
      NodeAssert.deepEqual(hub.onlineHosts("alice"), ["laptop"]);

      const client = await connect("pixel", "client");
      client.socket.send(JSON.stringify({ type: "open", channel: 3, hostDeviceId: "laptop" }));
      await second.inbox.next();
      second.socket.close();
      NodeAssert.deepEqual(await client.inbox.next(), {
        type: "close",
        channel: 3,
        reason: "peer_closed",
      });
      NodeAssert.deepEqual(hub.onlineHosts("alice"), []);
    });
  },
);

NodeTest.test("budget, channel caps and revocation stop traffic", async () => {
  await withRelay(
    devices,
    async ({ connect, exhaustBudget, revoke, sweep }) => {
      const host = await connect("laptop", "host");
      const client = await connect("pixel", "client");
      client.socket.send(JSON.stringify({ type: "open", channel: 1, hostDeviceId: "laptop" }));
      await host.inbox.next();
      client.socket.send(JSON.stringify({ type: "open", channel: 2, hostDeviceId: "laptop" }));
      NodeAssert.deepEqual(await client.inbox.next(), {
        type: "close",
        channel: 2,
        reason: "limit",
      });

      exhaustBudget();
      client.socket.send(JSON.stringify({ type: "close", channel: 1 }));
      await host.inbox.next();
      client.socket.send(JSON.stringify({ type: "open", channel: 4, hostDeviceId: "laptop" }));
      NodeAssert.deepEqual(await client.inbox.next(), {
        type: "close",
        channel: 4,
        reason: "limit",
      });

      revoke("pixel");
      await sweep();
      NodeAssert.deepEqual(await client.inbox.next(), { closed: 4401 });
    },
    { maxChannelsPerClient: 1 },
  );
});

NodeTest.test(
  "limits connection attempts per client IP, read behind the trusted proxy",
  async () => {
    await withRelay(
      devices,
      async ({ connect, url, logs }) => {
        const viaProxy = { "x-forwarded-for": "203.0.113.7" };
        await connect("laptop", "host", viaProxy);
        NodeAssert.equal(logs.find((event) => event.event === "relay.connect")?.ip, "203.0.113.7");
        await connect("pixel", "client", viaProxy);
        const refused = new WebSocket(url, { headers: viaProxy });
        const [, response] = await NodeEvents.once(refused, "unexpected-response");
        NodeAssert.equal(response.statusCode, 429);
        // Another address has its own allowance.
        const other = await connect("pixel", "client", { "x-forwarded-for": "198.51.100.2" });
        NodeAssert.deepEqual(other.first, { type: "ready", deviceId: "pixel" });
      },
      { connectsPerMinutePerIp: 2 },
      1,
    );
  },
);
