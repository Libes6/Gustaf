import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { DeviceGuard } from "../dist/devices/devices.controller.js";
import { RelayController } from "../dist/relay/relay.controller.js";

const device = (id, name, kind) => ({ id, name, kind });

NodeTest.test(
  "hosts lists the user's computers by name with who is online, and only computers",
  async () => {
    const asked = [];
    const controller = new RelayController(
      { hub: { onlineHosts: (userId) => (userId === "u1" ? ["vps"] : []) } },
      {
        list: async (userId) => {
          asked.push(userId);
          return [
            device("mac", "Mac", "computer"),
            device("vps", "VPS", "computer"),
            device("pixel", "Pixel", "phone"),
          ];
        },
      },
    );

    const answer = await controller.hosts({ device: { userId: "u1" } });

    // `online` stays what clients from before names read.
    NodeAssert.deepEqual(answer, {
      online: ["vps"],
      computers: [
        { id: "mac", name: "Mac", online: false },
        { id: "vps", name: "VPS", online: true },
      ],
    });
    NodeAssert.deepEqual(asked, ["u1"]);
  },
);

NodeTest.test("hosts answers only to a device's own token", () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, RelayController.prototype.hosts);
  NodeAssert.deepEqual(guards, [DeviceGuard]);
});
