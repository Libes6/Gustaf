/** One computer on a Gustaf account, as the relay's `GET /v1/relay/hosts` lists it. */
export interface RelayComputer {
  readonly deviceId: string;
  readonly name: string;
  readonly online: boolean;
}

/** What an API from before computers had names calls one. */
const relayComputerFallbackName = (deviceId: string) => `Computer ${deviceId.slice(0, 8)}`;

/**
 * Reads the answer of `GET /v1/relay/hosts`. Newer APIs list every computer by name; older ones
 * only the ids that are online, which then stand for the whole list.
 */
export function parseRelayComputers(body: unknown): ReadonlyArray<RelayComputer> {
  const answer = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const online = new Set(
    (Array.isArray(answer.online) ? answer.online : []).filter(
      (id): id is string => typeof id === "string",
    ),
  );
  if (!Array.isArray(answer.computers)) {
    return [...online].map((deviceId) => ({
      deviceId,
      name: relayComputerFallbackName(deviceId),
      online: true,
    }));
  }
  return answer.computers.flatMap((value): ReadonlyArray<RelayComputer> => {
    const computer =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    if (typeof computer.id !== "string") return [];
    const name = typeof computer.name === "string" ? computer.name.trim().slice(0, 100) : "";
    return [
      {
        deviceId: computer.id,
        name: name === "" ? relayComputerFallbackName(computer.id) : name,
        online: computer.online === true || online.has(computer.id),
      },
    ];
  });
}
