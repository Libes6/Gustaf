async (page) => {
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.addInitScript(() => {
    const now = Date.now();
    const S = {
      onboarded: true,
      locale: "ru",
      providers: [
        { id: "c1", kind: "cli", name: "Cursor Agent", baseUrl: "", cli: "cursor-agent" },
        { id: "p1", kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
      ],
      selection: { providerId: "p1", model: "gpt-5.5" },
    };
    const projects = [
      { id: 1, name: "grill", path: "/Users/me/pet/grill", pinned: 1, created_at: now },
      { id: 2, name: "gustaf", path: "/Users/me/pet/gustaf", pinned: 0, created_at: now },
    ];
    const chats = [
      { id: 1, project_id: 1, title: "Карта заказов: кластеры", archived: 0, created_at: now, updated_at: now },
      { id: 2, project_id: 1, title: "Фикс фильтров", archived: 0, created_at: now, updated_at: now - 86400000 },
      { id: 3, project_id: 2, title: "Onboarding", archived: 0, created_at: now, updated_at: now - 3600000 },
    ];
    const msg = (id, role, parts, meta = {}) => ({ id, chat_id: 1, role, created_at: now, content: JSON.stringify({ role, parts, meta }) });
    const messages = [
      msg(1, "user", [{ type: "text", text: "Сгруппируй маркеры заказов в кластеры и покажи счётчик" }]),
      msg(2, "assistant", [
        { type: "text", text: "Посмотрю, как сейчас рендерятся маркеры." },
        { type: "tool_call", id: "c1", name: "search", args: { pattern: "Marker" } },
      ], { provider: "p1", model: "gpt-5.5" }),
      msg(3, "tool", [{ type: "tool_result", id: "c1", name: "search", output: "src/Map.tsx:12: <Marker ...>" }]),
      msg(4, "assistant", [{ type: "text", text: "Готово. Добавил `MarkerClusterer`:\n\n```ts\nconst clusterer = new MarkerClusterer({ map, markers });\n```\n\n- счётчик в кружке\n- клик приближает" }], { provider: "p1", model: "gpt-5.5", durationMs: 42000 }),
    ];
    let cb = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: (f) => { const id = ++cb; window["_" + id] = f; return id; },
      unregisterCallback: () => {},
      invoke: async (cmd, args) => {
        if (cmd === "db_select") {
          const q = args.sql;
          if (/where key = \?/.test(q)) { const v = S[args.params[0]]; return v === undefined ? [] : [{ value: JSON.stringify(v) }]; }
          if (/from projects/.test(q)) return projects;
          if (/from chats where archived = 0/.test(q)) return chats;
          if (/from messages/.test(q)) return args.params[0] === 1 ? messages : [];
          return [];
        }
        if (cmd === "db_execute") return [0, 0];
        if (cmd === "secret_get") return "sk-test";
        if (cmd === "git") return args.args[0] === "rev-parse" ? "main" : "";
        if (cmd === "fs_files") return ["src/Map.tsx", "src/App.tsx"];
        if (cmd === "cu_permissions") return { accessibility: false, screen: false };
        if (cmd === "cu_screen_size") return [1512, 982];
        if (cmd.startsWith("plugin:http|fetch")) throw new Error("offline mock");
        if (cmd === "plugin:shell|execute") {
          const script = String(args.args?.[1] ?? "");
          const stdout = script.includes("--list-models")
            ? "auto - Auto (default)\ncomposer-2.5 - Composer 2.5\nclaude-opus-5-5 - Claude Opus 5.5\ngpt-5.5 - GPT-5.5\n"
            : "claude\t2.1.284 (Claude Code)\ncursor-agent\t2026.08.31-4057e58\n";
          return { code: 0, signal: null, stdout, stderr: "" };
        }
        return null;
      },
    };
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto("http://localhost:1420/");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "/tmp/mc-home.png" });
  await page.getByText("Карта заказов: кластеры").first().click({ timeout: 3000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/mc-chat.png" });
  await page.keyboard.press("Meta+,");
  await page.getByText("Провайдеры моделей").first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/mc-providers.png" });
  return errs.slice(0, 10);
}
