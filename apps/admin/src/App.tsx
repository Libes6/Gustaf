import { RouterProvider } from "@tanstack/react-router";

import { useMe } from "./api/queries";
import { LoadingState, ErrorState } from "./components/states";
import { resolveGate } from "./lib/rules";
import { router } from "./router";
import { NoAccessScreen, SignInScreen } from "./pages/AuthScreens";

export function App() {
  const me = useMe();
  const gate = resolveGate(me);
  switch (gate.state) {
    case "loading":
      return (
        <main className="grid min-h-dvh place-items-center">
          <LoadingState />
        </main>
      );
    case "signed-out":
      return <SignInScreen />;
    case "no-access":
      return <NoAccessScreen me={gate.me} />;
    case "error":
      return (
        <main className="grid min-h-dvh place-items-center p-4">
          <ErrorState error={gate.error} onRetry={() => void me.refetch()} />
        </main>
      );
    case "admin":
      return <RouterProvider router={router} context={{ me: gate.me }} />;
  }
}
