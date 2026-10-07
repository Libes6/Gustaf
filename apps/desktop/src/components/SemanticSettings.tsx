import { SettingRow } from "./SettingRow";
import { useEffect, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";
import {
  buildSemantic,
  clearSemantic,
  loadSemantic,
  normalizeSemantic,
  saveSemantic,
  semanticSearch,
  type SemanticConfig,
  type SemanticHit,
} from "../agent/semanticSearch";
export function SemanticSettings() {
  const app = useApp(),
    t = useT(),
    ru = t.locale === "ru";
  const projects = app.projects.filter((p) => p.path);
  const [root, setRoot] = useState(projects[0]?.path ?? "");
  const [config, setConfig] = useState<SemanticConfig>(normalizeSemantic(null));
  const [key, setKey] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [hits, setHits] = useState<SemanticHit[]>([]);
  useEffect(() => {
    let live = true;
    setKey("");
    setHits([]);
    setStatus("");
    if (root)
      loadSemantic(root)
        .then((c) => live && setConfig(c))
        .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [root]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    await saveSemantic(root, config, key);
    setKey("");
    setConfig(await loadSemantic(root));
  };
  return (
    <>
      <h4>{ru ? "Поиск по смыслу в проекте" : "Semantic project search"}</h4>
      <p className="lead">
        {ru
          ? "Выключен по умолчанию. При включении исходники отправляются выбранному endpoint для embeddings. Ollama работает локально; облачный endpoint может тарифицировать запросы. Игнорируемые и скрытые файлы, .env, ключи и бинарные файлы не индексируются. Не скачивает модель автоматически."
          : "Disabled by default. Source chunks are sent to your selected embeddings endpoint. Ollama runs locally; cloud providers may bill requests. Ignored/hidden files, .env, keys and binaries are excluded. Models are not downloaded automatically."}
      </p>
      {!projects.length ? (
        <p>{ru ? "Сначала добавьте проект" : "Add a project first"}</p>
      ) : (
        <>
          <select
            className="input"
            aria-label={ru ? "Проект для поиска" : "Search project"}
            value={root}
            disabled={busy}
            onChange={(e) => setRoot(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.path!}>
                {p.name}
              </option>
            ))}
          </select>
          <SettingRow id="semanticEnable" title={t("semanticEnable")}>
            <input
              type="checkbox"
              aria-label={t("semanticEnable")}
              checked={config.enabled}
              disabled={busy}
              onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
            />
          </SettingRow>
          <label htmlFor="semantic-provider">{ru ? "Провайдер" : "Provider"}</label>
          <select
            className="input"
            id="semantic-provider"
            value={config.kind}
            disabled={busy}
            onChange={(e) =>
              setConfig({
                ...config,
                kind: e.target.value as "ollama" | "openai",
                endpoint: e.target.value === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1",
                model: e.target.value === "ollama" ? "embeddinggemma" : "text-embedding-3-small",
              })
            }
          >
            <option value="ollama">Ollama (local)</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
          <label htmlFor="semantic-endpoint">Endpoint</label>
          <input
            className="input"
            id="semantic-endpoint"
            value={config.endpoint}
            disabled={busy}
            onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
          />
          <label htmlFor="semantic-model">{ru ? "Модель embeddings" : "Embeddings model"}</label>
          <input
            className="input"
            id="semantic-model"
            value={config.model}
            disabled={busy}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
          />
          {config.kind === "openai" && (
            <>
              <label htmlFor="semantic-key">API key {config.keyId ? "(saved)" : ""}</label>
              <input
                className="input"
                id="semantic-key"
                type="password"
                value={key}
                autoComplete="off"
                disabled={busy}
                placeholder={config.keyId ? "••••••••" : ""}
                onChange={(e) => setKey(e.target.value)}
              />
            </>
          )}
          <div className="card-row">
            <button
              className="btn btn-primary"
              disabled={busy || !config.model || !config.endpoint}
              onClick={() =>
                run(async () => {
                  await save();
                  setStatus(ru ? "Сохранено" : "Saved");
                })
              }
            >
              {t("save")}
            </button>
            <button
              className="btn-soft"
              disabled={busy || !config.enabled}
              onClick={() =>
                run(async () => {
                  await save();
                  const stats = await buildSemantic(root, await loadSemantic(root));
                  setStatus(
                    `${stats.files} files · ${stats.chunks} chunks · ${stats.embedded} embedded · ${stats.reused} reused · ${stats.skipped} skipped`,
                  );
                })
              }
            >
              {ru ? "Обновить индекс" : "Update index"}
            </button>
            <button
              className="btn-soft"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await clearSemantic(root);
                  setStatus(ru ? "Индекс удалён" : "Index removed");
                })
              }
            >
              {ru ? "Удалить индекс" : "Clear index"}
            </button>
          </div>
          <label htmlFor="semantic-query">{ru ? "Проверить поиск" : "Test search"}</label>
          <input
            id="semantic-query"
            className="input"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="btn-soft"
            disabled={busy || !config.enabled || !query.trim()}
            onClick={() =>
              run(async () => {
                await save();
                setHits(await semanticSearch(root, query));
              })
            }
          >
            {ru ? "Найти" : "Search"}
          </button>
          {hits.map((hit) => (
            <pre className="term" key={`${hit.path}:${hit.start}`}>
              <strong>
                {hit.path}:{hit.start}–{hit.end} · {hit.score.toFixed(3)}
              </strong>
              {"\n"}
              {hit.text}
            </pre>
          ))}
        </>
      )}
      {status && <p role="status">{status}</p>}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
