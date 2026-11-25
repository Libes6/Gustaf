import {
  ANOTHER_ADDRESS,
  type LinkableMachine,
  linkDestination,
  relayChoice,
  relayDeviceOfChoice,
} from "@t3tools/client-runtime/link-request";
import type { PeerLinkRelayMachine } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useId } from "react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const T3_CONNECT_NAME = "T3 Connect";

/**
 * Shown wherever a link goes to an address this app does not already have for a
 * machine, with where that address leads.
 */
export function LinkAddressWarning({ address }: { readonly address: string }) {
  return (
    <Alert variant="warning">
      <AlertTitle>
        <T>Check this address</T>
      </AlertTitle>
      <AlertDescription>
        <T>
          This app cannot confirm it is one of your machines. The pairing code you paste is sent
          there.
        </T>
        <span className="block break-all">{linkDestination(address)}</span>
      </AlertDescription>
    </Alert>
  );
}

/** Whether a machine is linked already, or how this app knows it when not connected to it. */
export function LinkMachineBadge({ machine }: { readonly machine: LinkableMachine }) {
  const gt = useGT();
  if (machine.linked) {
    return (
      <Badge variant="success" size="sm">
        <T>Linked</T>
      </Badge>
    );
  }
  if (machine.connected) return null;
  return (
    <Badge variant="outline" size="sm">
      {machine.connectOnly ? T3_CONNECT_NAME : gt("Not connected")}
    </Badge>
  );
}

function MachineName({ machine }: { readonly machine: LinkableMachine }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <EnvironmentMachineIcon kind={machine.machine} className="size-4 shrink-0 opacity-80" />
      <span className="min-w-0 truncate">{machine.label}</span>
    </span>
  );
}

/** One of the account's other computers, reached through the Gustaf relay. */
export function RelayMachineName({ machine }: { readonly machine: PeerLinkRelayMachine }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <EnvironmentMachineIcon kind="server" className="size-4 shrink-0 opacity-80" />
      <span className="min-w-0 truncate">{machine.name}</span>
    </span>
  );
}

/** Whether a relay computer is linked already, or why it cannot be right now. */
export function RelayMachineBadge({ machine }: { readonly machine: PeerLinkRelayMachine }) {
  if (machine.linkedEnvironmentId !== undefined) {
    return (
      <Badge variant="success" size="sm">
        <T>Linked</T>
      </Badge>
    );
  }
  return machine.online ? (
    <Badge variant="outline" size="sm">
      <T>Gustaf relay</T>
    </Badge>
  ) : (
    <Badge variant="outline" size="sm">
      <T>Offline</T>
    </Badge>
  );
}

/**
 * The user's other machines, including those on their T3 Connect account and the computers on
 * their Gustaf account that the relay reaches with no address, then an address.
 */
export function LinkMachineSelect({
  machines,
  relayMachines = [],
  value,
  onChange,
  disabled,
}: {
  readonly machines: ReadonlyArray<LinkableMachine>;
  readonly relayMachines?: ReadonlyArray<PeerLinkRelayMachine>;
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const labelId = useId();
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium text-foreground">
        <T>Machine</T>
      </span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next as string);
        }}
      >
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue>
            {(selected: string | null) => {
              if (selected === ANOTHER_ADDRESS) return gt("Another address…");
              const relayDevice = relayDeviceOfChoice(selected);
              const relayMachine =
                relayDevice === null
                  ? undefined
                  : relayMachines.find((candidate) => candidate.deviceId === relayDevice);
              if (relayMachine !== undefined) return <RelayMachineName machine={relayMachine} />;
              const machine = machines.find((candidate) => candidate.environmentId === selected);
              return machine === undefined ? (
                gt("Choose a machine")
              ) : (
                <MachineName machine={machine} />
              );
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {machines.map((machine) => (
            <SelectItem key={machine.environmentId} value={machine.environmentId} hideIndicator>
              <span className="flex min-w-0 items-center justify-between gap-3">
                <MachineName machine={machine} />
                <LinkMachineBadge machine={machine} />
              </span>
            </SelectItem>
          ))}
          {relayMachines.map((machine) => (
            <SelectItem
              key={machine.deviceId}
              value={relayChoice(machine.deviceId)}
              disabled={!machine.online}
              hideIndicator
            >
              <span className="flex min-w-0 items-center justify-between gap-3">
                <RelayMachineName machine={machine} />
                <RelayMachineBadge machine={machine} />
              </span>
            </SelectItem>
          ))}
          <SelectItem value={ANOTHER_ADDRESS} hideIndicator>
            <T>Another address…</T>
          </SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
}
