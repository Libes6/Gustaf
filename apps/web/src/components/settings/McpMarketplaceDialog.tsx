import type { EnvironmentId, McpRegistryEntry, McpServerConfig } from "@t3tools/contracts";
import {
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
  type McpCatalogCategory,
  type McpCatalogEntry,
} from "@t3tools/shared/mcpCatalog";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Spinner } from "../ui/spinner";
import {
  canOneClickInstall,
  catalogEntryToDraft,
  filterCatalogEntries,
  isMarketplaceServerInstalled,
  registryEntryToDraft,
  type MarketplaceDraft,
} from "./McpMarketplace.logic";

const REGISTRY_SEARCH_DEBOUNCE_MS = 350;

const CATEGORY_LABELS: Readonly<Record<McpCatalogCategory, string>> = {
  developer: msg("Developer"),
  browser: msg("Browser & QA"),
  docs: msg("Docs & Search"),
  productivity: msg("Productivity"),
  data: msg("Data"),
  cloud: msg("Cloud"),
};

export function McpMarketplaceDialog({
  environmentId,
  installedServers,
  canEdit,
  localAllowed,
  busy,
  onInstallDirect,
  onConfigureDraft,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly installedServers: Readonly<Record<string, McpServerConfig>>;
  readonly canEdit: boolean;
  readonly localAllowed: boolean;
  readonly busy: boolean;
  readonly onInstallDirect: (draft: MarketplaceDraft) => Promise<void>;
  readonly onConfigureDraft: (draft: MarketplaceDraft) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const [tab, setTab] = useState<"featured" | "registry">("featured");
  const [featuredQuery, setFeaturedQuery] = useState("");
  const [category, setCategory] = useState<McpCatalogCategory | "all">("all");
  const [installingId, setInstallingId] = useState<string | null>(null);

  const searchRegistry = useAtomCommand(serverEnvironment.mcpSearchRegistry, {
    reportFailure: false,
  });
  const [registryInput, setRegistryInput] = useState<{
    readonly text: string;
    readonly submitted: string;
    readonly typedAt: number | null;
  }>({ text: "", submitted: "", typedAt: null });
  const registrySettled = useDeadlinePassed(
    registryInput.typedAt === null ? null : registryInput.typedAt + REGISTRY_SEARCH_DEBOUNCE_MS,
  );
  const registryQuery = registrySettled ? registryInput.text.trim() : registryInput.submitted;
  const [registryState, setRegistryState] = useState<{
    readonly requestKey: string | null;
    readonly status: "idle" | "loaded" | "error";
    readonly entries: ReadonlyArray<McpRegistryEntry>;
  }>({ requestKey: null, status: "idle", entries: [] });
  const [retryCount, setRetryCount] = useState(0);
  const requestKey = `${registryQuery}\0${retryCount}`;

  const runRegistrySearch = useEffectEvent(
    (query: string, key: string, isCurrent: () => boolean) => {
      void searchRegistry({ environmentId, input: { query, limit: 24 } }).then((result) => {
        if (!isCurrent()) return;
        if (result._tag === "Success") {
          setRegistryState({ requestKey: key, status: "loaded", entries: result.value.entries });
        } else {
          setRegistryState({ requestKey: key, status: "error", entries: [] });
        }
      });
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Registry lookup only fires when the Registry tab is active or the debounced query changes.
  useEffect(() => {
    if (tab !== "registry") return;
    let current = true;
    runRegistrySearch(registryQuery, requestKey, () => current);
    return () => {
      current = false;
    };
  }, [tab, registryQuery, requestKey]);

  const registryLoading = tab === "registry" && registryState.requestKey !== requestKey;

  const featuredEntries = filterCatalogEntries(MCP_CATALOG, featuredQuery, category);

  async function handleAction(draft: MarketplaceDraft) {
    if (canOneClickInstall(draft, installedServers)) {
      setInstallingId(draft.id);
      await onInstallDirect(draft).finally(() => {
        setInstallingId(null);
      });
      return;
    }
    onConfigureDraft(draft);
  }

  function renderFeaturedCard(entry: McpCatalogEntry) {
    const installed = isMarketplaceServerInstalled(installedServers, entry);
    const draft = catalogEntryToDraft(entry);
    const blockedLocal = entry.transport.type === "stdio" && !localAllowed;
    const direct = canOneClickInstall(draft, installedServers);
    const isInstalling = installingId === entry.id;
    return (
      <div
        key={entry.id}
        className="flex flex-col justify-between gap-3 rounded-lg border border-border/70 bg-card/40 p-3.5"
      >
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
              <Badge variant="outline" size="sm">
                {entry.transport.type === "http" ? gt("Remote HTTP") : gt("Local stdio")}
              </Badge>
              <Badge variant="secondary" size="sm">
                {entry.authHint === "oauth"
                  ? gt("OAuth sign-in")
                  : entry.authHint === "api-key"
                    ? gt("API key")
                    : gt("No auth")}
              </Badge>
            </div>
            <a
              href={entry.homepageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <T>Docs</T>
              <ExternalLinkIcon className="size-3" />
            </a>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {locale.startsWith("ru") ? entry.descriptionRu : entry.descriptionEn}
          </p>
          {entry.requiredSecrets.length > 0 && (
            <p className="font-mono text-2xs text-muted-foreground/80">
              <T>
                Requires: <Var>{entry.requiredSecrets.map((s) => s.key).join(", ")}</Var>
              </T>
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="truncate font-mono text-2xs text-muted-foreground/75">
            {entry.transport.type === "http"
              ? entry.transport.url
              : [entry.transport.command, ...entry.transport.args].join(" ")}
          </span>
          {installed ? (
            <Badge variant="success" size="sm">
              <T>Installed</T>
            </Badge>
          ) : blockedLocal ? (
            <Badge variant="outline" size="sm">
              <T>Blocked by policy</T>
            </Badge>
          ) : (
            <Button
              size="xs"
              variant={direct ? "default" : "outline"}
              disabled={!canEdit || busy || installingId !== null}
              onClick={() => void handleAction(draft)}
            >
              {isInstalling
                ? gt("Installing…")
                : direct
                  ? gt("Install", { $context: "verb, installs an MCP server" })
                  : gt("Configure")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  function renderRegistryCard(entry: McpRegistryEntry) {
    const draft = registryEntryToDraft(entry);
    const installed = isMarketplaceServerInstalled(installedServers, {
      id: draft.id,
      transport: entry.transport,
    });
    const blockedLocal = entry.transport.type === "stdio" && !localAllowed;
    const direct = canOneClickInstall(draft, installedServers);
    const isInstalling = installingId === draft.id;
    const docsUrl = entry.homepageUrl ?? entry.repositoryUrl;
    return (
      <div
        key={entry.registryName}
        className="flex flex-col justify-between gap-3 rounded-lg border border-border/70 bg-card/40 p-3.5"
      >
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
              <Badge variant="outline" size="sm">
                {entry.transport.type === "http" ? gt("Remote HTTP") : gt("Local stdio")}
              </Badge>
              {entry.version && (
                <span className="font-mono text-2xs text-muted-foreground">{`v${entry.version}`}</span>
              )}
            </div>
            {docsUrl && (
              <a
                href={docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <T>Docs</T>
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>
          {entry.description && (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {entry.description}
            </p>
          )}
          {draft.secretKeys.length > 0 && (
            <p className="font-mono text-2xs text-muted-foreground/80">
              <T>
                Requires: <Var>{draft.secretKeys.join(", ")}</Var>
              </T>
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="truncate font-mono text-2xs text-muted-foreground/75">
            {entry.transport.type === "http"
              ? entry.transport.url
              : [entry.transport.command, ...entry.transport.args].join(" ")}
          </span>
          {installed ? (
            <Badge variant="success" size="sm">
              <T>Installed</T>
            </Badge>
          ) : blockedLocal ? (
            <Badge variant="outline" size="sm">
              <T>Blocked by policy</T>
            </Badge>
          ) : (
            <Button
              size="xs"
              variant={direct ? "default" : "outline"}
              disabled={!canEdit || busy || installingId !== null}
              onClick={() => void handleAction(draft)}
            >
              {isInstalling
                ? gt("Installing…")
                : direct
                  ? gt("Install", { $context: "verb, installs an MCP server" })
                  : gt("Configure")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && installingId === null) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            <T>MCP Marketplace</T>
          </DialogTitle>
          <DialogDescription>
            <T>Install popular MCP servers in one click or search the official MCP Registry.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant={tab === "featured" ? "secondary" : "ghost"}
                  onClick={() => setTab("featured")}
                >
                  <T>Featured</T>
                </Button>
                <Button
                  size="xs"
                  variant={tab === "registry" ? "secondary" : "ghost"}
                  onClick={() => setTab("registry")}
                >
                  <T>MCP Registry</T>
                </Button>
              </div>
              <div className="min-w-56 flex-1 sm:max-w-xs">
                <InputGroup>
                  <InputGroupAddon>
                    <SearchIcon className="size-3.5" />
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-label={
                      tab === "featured"
                        ? gt("Filter popular MCP servers…")
                        : gt("Search official MCP Registry…")
                    }
                    placeholder={
                      tab === "featured"
                        ? gt("Filter popular MCP servers…")
                        : gt("Search official MCP Registry…")
                    }
                    value={tab === "featured" ? featuredQuery : registryInput.text}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (tab === "featured") {
                        setFeaturedQuery(next);
                      } else {
                        setRegistryInput((prev) => ({
                          ...prev,
                          text: next,
                          typedAt: Date.now(),
                        }));
                      }
                    }}
                  />
                </InputGroup>
              </div>
            </div>

            {tab === "featured" ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    variant={category === "all" ? "secondary" : "ghost"}
                    onClick={() => setCategory("all")}
                  >
                    <T>All</T>
                  </Button>
                  {MCP_CATALOG_CATEGORIES.map((cat) => (
                    <Button
                      key={cat}
                      size="xs"
                      variant={category === cat ? "secondary" : "ghost"}
                      onClick={() => setCategory(cat)}
                    >
                      {m(CATEGORY_LABELS[cat])}
                    </Button>
                  ))}
                </div>
                {featuredEntries.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    <T>No featured servers match this filter.</T>
                  </p>
                ) : (
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {featuredEntries.map(renderFeaturedCard)}
                  </div>
                )}
              </>
            ) : registryLoading && registryState.entries.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner size="sm" />
                <T>Searching the official MCP Registry…</T>
              </div>
            ) : registryState.status === "error" ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  <T>Could not load servers from the official MCP Registry.</T>
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setRetryCount((count) => count + 1)}
                >
                  <T>Retry</T>
                </Button>
              </div>
            ) : registryState.entries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                <T>No MCP Registry servers matched your search.</T>
              </p>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2">
                {registryState.entries.map(renderRegistryCard)}
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={installingId !== null} onClick={onClose}>
            <T>Close</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
