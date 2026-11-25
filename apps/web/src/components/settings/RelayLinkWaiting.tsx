import { T, Var } from "gt-react";

/**
 * Shown while a machine of the user's account is asked, through the Gustaf relay, to allow a link.
 * Both machines show the same code: matching codes mean nobody sits between them.
 */
export function RelayLinkWaiting(props: {
  readonly name: string;
  /** Null while the machine is still being reached. */
  readonly safetyCode: string | null;
}) {
  return (
    <div role="status" className="space-y-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
      {props.safetyCode === null ? (
        <p className="text-muted-foreground">
          <T>
            Reaching <Var>{props.name}</Var> through the Gustaf relay…
          </T>
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">
            <T>
              Waiting for <Var>{props.name}</Var> to allow this. Open Gustaf there and check that it
              shows this code before allowing it:
            </T>
          </p>
          <p className="font-mono text-base font-semibold tracking-wider select-all">
            {props.safetyCode}
          </p>
        </>
      )}
    </div>
  );
}
