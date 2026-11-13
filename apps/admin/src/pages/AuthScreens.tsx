import { GithubIcon, LogOutIcon, ShieldIcon, ShieldOffIcon } from "lucide-react";
import type * as React from "react";

import { useSignIn, useSignOut } from "../api/queries";
import type { Me } from "../api/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { errorMessage } from "../lib/format";
import { strings } from "../strings";

function CenteredCard({
  icon,
  title,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="flex w-full max-w-sm flex-col items-center gap-4 p-6 text-center">
        {icon}
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </Card>
    </main>
  );
}

export function SignInScreen() {
  const signIn = useSignIn();
  // A successful start navigates away, so pending stays true until the page unloads.
  const busy = signIn.isPending || signIn.isSuccess;
  return (
    <CenteredCard
      icon={<ShieldIcon aria-hidden className="size-6 text-primary" />}
      title={strings.signIn.title}
    >
      <p className="text-sm text-muted-foreground">{strings.signIn.description}</p>
      <Button size="lg" className="w-full" disabled={busy} onClick={() => signIn.mutate()}>
        <GithubIcon aria-hidden />
        {busy ? strings.signIn.redirecting : strings.signIn.button}
      </Button>
      {signIn.isError ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {strings.signIn.failed} {errorMessage(signIn.error)}
        </p>
      ) : null}
    </CenteredCard>
  );
}

export function NoAccessScreen({ me }: { readonly me: Me | null }) {
  const signOut = useSignOut();
  return (
    <CenteredCard
      icon={<ShieldOffIcon aria-hidden className="size-6 text-destructive" />}
      title={strings.noAccess.title}
    >
      <p className="text-sm text-muted-foreground">
        {strings.noAccess.description(me?.name ?? me?.email ?? strings.common.you)}
      </p>
      <Button
        variant="outline"
        className="w-full"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        <LogOutIcon aria-hidden />
        {strings.nav.signOut}
      </Button>
    </CenteredCard>
  );
}
