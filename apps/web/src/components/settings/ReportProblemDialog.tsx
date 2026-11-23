import { T, useGT } from "gt-react";
import { useState } from "react";

import type { ShellAccount } from "../../shellAccount";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

const MAX_MESSAGE = 5000;

/** The shell sends the report with the account session and collects logs only when asked. */
export function ReportProblemDialog({
  account,
  onClose,
}: {
  account: ShellAccount;
  onClose: () => void;
}) {
  const gt = useGT();
  const [message, setMessage] = useState("");
  const [attachLogs, setAttachLogs] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = message.trim().length > 0;

  const send = () => {
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    account
      .reportProblem({ message, attachLogs })
      .then(() => {
        toastManager.add(
          stackedThreadToast({ type: "success", title: gt("Report sent. Thank you!") }),
        );
        onClose();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setSending(false);
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
    >
      <DialogPopup showCloseButton={!sending}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Report a problem</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Describe what happened and what you expected. The report is sent with your account,
                the app version and your platform.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Textarea
                autoFocus
                rows={6}
                maxLength={MAX_MESSAGE}
                value={message}
                disabled={sending}
                aria-label={gt("What went wrong")}
                placeholder={gt("What did you do, and what happened?")}
                onChange={(event) => setMessage(event.target.value)}
              />
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={attachLogs}
                  disabled={sending}
                  onCheckedChange={(checked) => setAttachLogs(checked === true)}
                />
                <span className="min-w-0">
                  <span className="block">
                    <T>Attach logs</T>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      Recent app and server logs. Tokens and passwords are removed, but logs can
                      include file names from this computer.
                    </T>
                  </span>
                </span>
              </label>
              {error === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={sending} onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={sending || !valid}>
              {sending ? <Spinner size="xs" /> : null} <T>Send report</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
