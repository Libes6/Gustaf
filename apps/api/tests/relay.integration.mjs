import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeTest from "node:test";
import pg from "pg";
import { WebSocket } from "ws";
import { githubUser, registerDevice, signIn, withApi } from "./support/github-sign-in.mjs";

async function relaySocket(base, deviceToken, role) {
  const socket = new WebSocket(`${base.replace("http", "ws")}/v1/relay`);
  await NodeEvents.once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", token: deviceToken, role }));
  const [data] = await NodeEvents.once(socket, "message");
  return { socket, first: JSON.parse(data.toString()) };
}

NodeTest.test(
  "the relay authenticates device tokens, reports presence and meters bytes",
  async () => {
    let userId;
    await withApi(async ({ base, api, pool }) => {
      const alice = await signIn(base, githubUser("alice"));
      const laptop = await registerDevice(api, { bearer: alice.bearer }, "Laptop", "computer");
      const phone = await registerDevice(api, { bearer: alice.bearer }, "Pixel", "phone");

      userId = (await pool.query("select user_id from device where id = $1", [laptop.device.id]))
        .rows[0].user_id;
      const host = await relaySocket(base, laptop.token, "host");
      NodeAssert.deepEqual(host.first, { type: "ready", deviceId: laptop.device.id });
      const client = await relaySocket(base, phone.token, "client");
      NodeAssert.deepEqual(client.first, { type: "ready", deviceId: phone.device.id });

      const presence = await api("/v1/relay/hosts", { auth: { bearer: phone.token } });
      NodeAssert.deepEqual(presence.body, { online: [laptop.device.id] });

      client.socket.send(
        JSON.stringify({ type: "open", channel: 1, hostDeviceId: laptop.device.id }),
      );
      const [opened] = await NodeEvents.once(host.socket, "message");
      NodeAssert.equal(JSON.parse(opened.toString()).clientDeviceId, phone.device.id);
      const payload = Buffer.alloc(1004);
      payload.writeUInt32BE(1, 0);
      client.socket.send(payload);
      await NodeEvents.once(host.socket, "message");

      // Revoked now, the phone's socket closes at the next heartbeat (covered by relay.test.mjs).
      NodeAssert.equal(
        (
          await api(`/v1/devices/${phone.device.id}`, {
            auth: { bearer: alice.bearer },
            method: "DELETE",
          })
        ).status,
        204,
      );
      const closed = NodeEvents.once(client.socket, "close");
      host.socket.close();
      client.socket.close();
      await closed;
    });
    // Shutting the app down flushes the byte counter.
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      const usage = await pool.query("select bytes from relay_usage where user_id = $1", [userId]);
      NodeAssert.equal(Number(usage.rows[0]?.bytes), 1004);
    } finally {
      await pool.end();
    }
  },
);
