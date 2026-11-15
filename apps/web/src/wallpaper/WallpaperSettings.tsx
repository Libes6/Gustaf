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
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useT } from "../useUiLanguage";
import {
  parseWallpaperInstall,
  resolveWallpaperSceneUrl,
  useWallpaperLibrary,
  type WallpaperInstallFile,
} from "./wallpaperLibrary";

export function WallpaperSettings() {
  const library = useWallpaperLibrary();
  const t = useT();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function install(files: ReadonlyArray<WallpaperInstallFile>) {
    const result = parseWallpaperInstall(files);
    if (!result.ok) {
      setError(t(result.reason === "too-large" ? "wallpaper.tooLarge" : "wallpaper.invalidScene"));
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
      if (selected.some((file) => file.size > 200_000)) {
        setError(t("wallpaper.tooLarge"));
      } else {
        install(
          await Promise.all(
            selected.map(async (file) => ({ name: file.name, text: await file.text() })),
          ),
        );
      }
    } catch {
      setError(t("wallpaper.importFailed"));
    }
    setBusy(false);
  }

  async function importUrl() {
    const sceneUrl = resolveWallpaperSceneUrl(url);
    if (sceneUrl === null) {
      setError(t("wallpaper.invalidUrl"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(sceneUrl, {
        credentials: "omit",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const text = await response.text();
      install([{ name: "scene.js", text }]);
    } catch {
      setError(t("wallpaper.importFailed"));
    }
    setBusy(false);
  }

  return (
    <SettingsSection id="appearance-wallpaper" title={t("wallpaper.title")}>
      <SettingsRow
        title={t("wallpaper.scene")}
        description={t("wallpaper.description")}
        control={
          <div className="w-full sm:w-48">
            <Select
              value={library.active?.id ?? "off"}
              onValueChange={(id) => library.select(id === "off" ? null : id)}
            >
              <SelectTrigger size="sm" className="w-full" aria-label={t("wallpaper.scene")}>
                <SelectValue>{library.active?.name ?? t("wallpaper.off")}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="off">{t("wallpaper.off")}</SelectItem>
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
      <div className="space-y-3 px-4 py-3">
        <p className="text-xs text-muted-foreground">{t("wallpaper.importDescription")}</p>
        <Input
          type="file"
          nativeInput
          multiple
          accept=".js,.mjs,.json"
          disabled={busy}
          aria-label={t("wallpaper.importFile")}
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
              aria-label={t("wallpaper.url")}
              disabled={busy}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !url.trim()}>
            {t(busy ? "wallpaper.importing" : "wallpaper.install")}
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
              aria-label={`${t("wallpaper.remove")} ${scene.name}`}
            >
              {t("wallpaper.remove")}
            </Button>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
