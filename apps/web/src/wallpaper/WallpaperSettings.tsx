import { T, useGT } from "gt-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  MAX_SCENE_FILE_BYTES,
  parseWallpaperInstall,
  resolveWallpaperSceneUrl,
  useWallpaperLibrary,
  type WallpaperInstallFile,
} from "./wallpaperLibrary";

export function WallpaperSettings() {
  const library = useWallpaperLibrary();
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offLabel = gt("Off", { $context: "chat wallpaper turned off" });
  const tooLarge = gt("Scene files must be smaller than 200 KB.");
  const importFailed = gt(
    "Could not import the scene. Check the file or download it and import it locally.",
  );

  function install(files: ReadonlyArray<WallpaperInstallFile>) {
    const result = parseWallpaperInstall(files);
    if (!result.ok) {
      setError(
        result.reason === "too-large"
          ? tooLarge
          : gt("Select a JavaScript scene that registers SCENES['name']."),
      );
      return;
    }
    library.install(result.wallpaper);
    setError(null);
  }

  async function importFiles(files: FileList) {
    setBusy(true);
    setError(null);
    try {
      const selected = Array.from(files);
      if (selected.some((file) => file.size > MAX_SCENE_FILE_BYTES)) {
        setError(tooLarge);
      } else {
        install(
          await Promise.all(
            selected.map(async (file) => ({ name: file.name, text: await file.text() })),
          ),
        );
      }
    } catch {
      setError(importFailed);
    }
    setBusy(false);
  }

  async function importUrl() {
    const sceneUrl = resolveWallpaperSceneUrl(url);
    if (sceneUrl === null) {
      setError(gt("Enter an HTTPS link to a scene file."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(sceneUrl, {
        credentials: "omit",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        install([{ name: "scene.js", text: await response.text() }]);
      } else {
        setError(importFailed);
      }
    } catch {
      setError(importFailed);
    }
    setBusy(false);
  }

  return (
    <SettingsSection id="appearance-wallpaper" title={gt("Chat wallpaper")}>
      <SettingsRow
        {...searchableSetting("chat-wallpaper")}
        title={gt("Scene")}
        description={gt("Shown behind the conversation on this device.")}
        control={
          <div className="w-full sm:w-48">
            <Select
              value={library.active?.id ?? "off"}
              onValueChange={(id) => library.select(id === "off" || id === null ? null : id)}
            >
              <SelectTrigger size="sm" className="w-full" aria-label={gt("Scene")}>
                <SelectValue>{library.active?.name ?? offLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="off">{offLabel}</SelectItem>
                {library.options.map((scene) => (
                  <SelectItem key={scene.id} value={scene.id}>
                    {scene.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <SettingsRow
        title={gt("Animate wallpaper")}
        description={gt(
          "Off shows a still frame. On keeps redrawing the scene while the window has focus, which uses more power. Reduced motion always keeps it still.",
        )}
        control={
          <Switch
            checked={library.animate}
            onCheckedChange={(animate) => library.setAnimate(animate)}
            aria-label={gt("Animate wallpaper")}
          />
        }
      />
      <div className="space-y-3 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          <T>
            Import a Claude Desktop Themes scene (.js), optionally with its theme .json. Or paste a
            direct link to a scene file, including a GitHub file link.
          </T>
        </p>
        <Input
          type="file"
          nativeInput
          multiple
          accept=".js,.mjs,.json"
          disabled={busy}
          aria-label={gt("Import scene files")}
          onChange={(event) => {
            const files = event.target.files;
            if (files) void importFiles(files);
            event.target.value = "";
          }}
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void importUrl();
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/…/scenes/sakura.js"
              aria-label={gt("Scene file URL")}
              disabled={busy}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !url.trim()}>
            {busy ? gt("Importing…") : gt("Install", { $context: "verb, installs a scene" })}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {library.installed.map((scene) => (
          <div key={scene.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate">{scene.name}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => library.remove(scene.id)}
              aria-label={gt("Remove {name}", { name: scene.name })}
            >
              {gt("Remove", { $context: "verb, removes an installed scene" })}
            </Button>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
