import { McpServerId, type McpServerConfig } from "@t3tools/contracts";

export type McpCatalogCategory =
  | "developer"
  | "browser"
  | "docs"
  | "productivity"
  | "data"
  | "cloud";

export type McpCatalogAuthHint = "none" | "oauth" | "api-key";

export interface McpCatalogSecretField {
  readonly key: string;
  readonly placeholder?: string;
}

export type McpCatalogTransport =
  | {
      readonly type: "http";
      readonly url: string;
    }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };

export interface McpCatalogEntry {
  readonly id: McpServerId;
  readonly name: string;
  readonly descriptionEn: string;
  readonly descriptionRu: string;
  readonly category: McpCatalogCategory;
  readonly homepageUrl: string;
  readonly authHint: McpCatalogAuthHint;
  readonly transport: McpCatalogTransport;
  readonly requiredSecrets: ReadonlyArray<McpCatalogSecretField>;
  readonly tags: ReadonlyArray<string>;
}

export const MCP_CATALOG_CATEGORIES: ReadonlyArray<McpCatalogCategory> = [
  "developer",
  "browser",
  "docs",
  "productivity",
  "data",
  "cloud",
];

export const MCP_CATALOG: ReadonlyArray<McpCatalogEntry> = [
  {
    id: McpServerId.make("context7"),
    name: "Context7",
    descriptionEn: "Up-to-date library documentation and code examples for any package.",
    descriptionRu: "Актуальная документация и примеры кода для библиотек и фреймворков.",
    category: "docs",
    homepageUrl: "https://context7.com",
    authHint: "none",
    transport: { type: "http", url: "https://mcp.context7.com/mcp" },
    requiredSecrets: [],
    tags: ["docs", "libraries", "reference"],
  },
  {
    id: McpServerId.make("github"),
    name: "GitHub",
    descriptionEn: "Repositories, pull requests, issues, code search, and GitHub Actions.",
    descriptionRu: "Репозитории, pull requests, issues, поиск по коду и GitHub Actions.",
    category: "developer",
    homepageUrl: "https://github.com/github/github-mcp-server",
    authHint: "oauth",
    transport: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    requiredSecrets: [],
    tags: ["git", "prs", "issues", "code"],
  },
  {
    id: McpServerId.make("linear"),
    name: "Linear",
    descriptionEn: "Create, update, and triage Linear issues, projects, and cycles.",
    descriptionRu: "Создание, обновление и триаж задач, проектов и циклов в Linear.",
    category: "productivity",
    homepageUrl: "https://linear.app/docs/mcp",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.linear.app/mcp" },
    requiredSecrets: [],
    tags: ["issues", "tracker", "tasks"],
  },
  {
    id: McpServerId.make("sentry"),
    name: "Sentry",
    descriptionEn: "Inspect production issues, stack traces, releases, and performance data.",
    descriptionRu: "Ошибки продакшена, стектрейсы, релизы и телеметрия из Sentry.",
    category: "developer",
    homepageUrl: "https://docs.sentry.io/product/sentry-mcp/",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.sentry.dev/mcp" },
    requiredSecrets: [],
    tags: ["errors", "monitoring", "debugging"],
  },
  {
    id: McpServerId.make("notion"),
    name: "Notion",
    descriptionEn: "Search, read, and update Notion pages and databases.",
    descriptionRu: "Поиск, чтение и редактирование страниц и баз данных Notion.",
    category: "productivity",
    homepageUrl: "https://developers.notion.com/docs/mcp",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.notion.com/mcp" },
    requiredSecrets: [],
    tags: ["wiki", "notes", "docs"],
  },
  {
    id: McpServerId.make("figma"),
    name: "Figma",
    descriptionEn: "Read Figma frames, design tokens, variables, and component specs.",
    descriptionRu: "Чтение фреймов, дизайн-токенов, переменных и спецификаций Figma.",
    category: "productivity",
    homepageUrl: "https://help.figma.com/hc/en-us/articles/32132100833559",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.figma.com/mcp" },
    requiredSecrets: [],
    tags: ["design", "ui", "tokens"],
  },
  {
    id: McpServerId.make("supabase"),
    name: "Supabase",
    descriptionEn: "Manage Supabase projects, Postgres tables, migrations, and Edge Functions.",
    descriptionRu: "Управление проектами Supabase, таблицами Postgres, миграциями и функциями.",
    category: "data",
    homepageUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.supabase.com/mcp" },
    requiredSecrets: [],
    tags: ["postgres", "database", "backend"],
  },
  {
    id: McpServerId.make("stripe"),
    name: "Stripe",
    descriptionEn: "Query Stripe customers, subscriptions, invoices, and API docs.",
    descriptionRu: "Клиенты, подписки, счета и документация API в Stripe.",
    category: "cloud",
    homepageUrl: "https://docs.stripe.com/mcp",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.stripe.com/mcp" },
    requiredSecrets: [],
    tags: ["payments", "billing"],
  },
  {
    id: McpServerId.make("vercel"),
    name: "Vercel",
    descriptionEn: "Inspect deployments, build logs, projects, and domains on Vercel.",
    descriptionRu: "Деплои, логи сборок, проекты и домены в Vercel.",
    category: "cloud",
    homepageUrl: "https://vercel.com/docs/mcp/vercel-mcp",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.vercel.com/mcp" },
    requiredSecrets: [],
    tags: ["deploy", "hosting", "logs"],
  },
  {
    id: McpServerId.make("posthog"),
    name: "PostHog",
    descriptionEn: "Query analytics, feature flags, experiments, and error tracking in PostHog.",
    descriptionRu: "Аналитика, фича-флаги, эксперименты и ошибки в PostHog.",
    category: "cloud",
    homepageUrl: "https://posthog.com/docs/model-context-protocol",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.posthog.com/mcp" },
    requiredSecrets: [],
    tags: ["analytics", "flags", "telemetry"],
  },
  {
    id: McpServerId.make("cloudflare-docs"),
    name: "Cloudflare Docs",
    descriptionEn: "Search Cloudflare Workers, R2, D1, Pages, and Zero Trust documentation.",
    descriptionRu: "Поиск по документации Cloudflare Workers, R2, D1, Pages и Zero Trust.",
    category: "docs",
    homepageUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
    authHint: "none",
    transport: { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" },
    requiredSecrets: [],
    tags: ["cloudflare", "workers", "docs"],
  },
  {
    id: McpServerId.make("neon"),
    name: "Neon",
    descriptionEn: "Create and inspect serverless Postgres branches, schemas, and queries.",
    descriptionRu: "Ветки serverless Postgres, схемы и SQL-запросы в Neon.",
    category: "data",
    homepageUrl: "https://neon.com/docs/ai/neon-mcp-server",
    authHint: "oauth",
    transport: { type: "http", url: "https://mcp.neon.tech/mcp" },
    requiredSecrets: [],
    tags: ["postgres", "database", "serverless"],
  },
  {
    id: McpServerId.make("playwright"),
    name: "Playwright",
    descriptionEn: "Automate real browsers using accessibility snapshots, clicks, and screenshots.",
    descriptionRu: "Автоматизация браузера через accessibility-снимки, клики и скриншоты.",
    category: "browser",
    homepageUrl: "https://github.com/microsoft/playwright-mcp",
    authHint: "none",
    transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    requiredSecrets: [],
    tags: ["browser", "testing", "e2e"],
  },
  {
    id: McpServerId.make("chrome-devtools"),
    name: "Chrome DevTools",
    descriptionEn:
      "Control Chrome, inspect console logs, network requests, and performance traces.",
    descriptionRu: "Управление Chrome, консоль, сеть и профилирование производительности.",
    category: "browser",
    homepageUrl: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    authHint: "none",
    transport: { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    requiredSecrets: [],
    tags: ["chrome", "devtools", "performance"],
  },
  {
    id: McpServerId.make("filesystem"),
    name: "Filesystem",
    descriptionEn: "Sandboxed local file read, search, and edit tools via MCP.",
    descriptionRu: "Безопасное чтение, поиск и редактирование локальных файлов через MCP.",
    category: "developer",
    homepageUrl: "https://github.com/modelcontextprotocol/servers",
    authHint: "none",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
    requiredSecrets: [],
    tags: ["files", "local"],
  },
  {
    id: McpServerId.make("memory"),
    name: "Memory",
    descriptionEn: "Persistent knowledge graph memory across agent sessions.",
    descriptionRu: "Постоянная память в виде графа знаний между сессиями агента.",
    category: "productivity",
    homepageUrl: "https://github.com/modelcontextprotocol/servers",
    authHint: "none",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    requiredSecrets: [],
    tags: ["memory", "knowledge-graph"],
  },
  {
    id: McpServerId.make("sequential-thinking"),
    name: "Sequential Thinking",
    descriptionEn: "Structured step-by-step reasoning and hypothesis revision tool.",
    descriptionRu: "Структурированное пошаговое рассуждение и проверка гипотез.",
    category: "developer",
    homepageUrl: "https://github.com/modelcontextprotocol/servers",
    authHint: "none",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    requiredSecrets: [],
    tags: ["reasoning", "planning"],
  },
  {
    id: McpServerId.make("fetch"),
    name: "Fetch",
    descriptionEn: "Fetch web pages and convert HTML to clean Markdown for agents.",
    descriptionRu: "Загрузка веб-страниц и конвертация HTML в чистый Markdown.",
    category: "docs",
    homepageUrl: "https://github.com/modelcontextprotocol/servers",
    authHint: "none",
    transport: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    requiredSecrets: [],
    tags: ["web", "http", "markdown"],
  },
  {
    id: McpServerId.make("postgres"),
    name: "PostgreSQL",
    descriptionEn: "Read-only schema inspection and SQL queries against a PostgreSQL database.",
    descriptionRu: "Инспекция схем и SQL-запросы к базе данных PostgreSQL.",
    category: "data",
    homepageUrl: "https://github.com/modelcontextprotocol/servers",
    authHint: "api-key",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
    },
    requiredSecrets: [
      { key: "POSTGRES_URL", placeholder: "postgresql://user:pass@localhost:5432/db" },
    ],
    tags: ["sql", "database", "postgres"],
  },
  {
    id: McpServerId.make("brave-search"),
    name: "Brave Search",
    descriptionEn: "Web and local search powered by the Brave Search API.",
    descriptionRu: "Поиск в интернете через Brave Search API.",
    category: "docs",
    homepageUrl: "https://github.com/modelcontextprotocol/servers",
    authHint: "api-key",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
    },
    requiredSecrets: [{ key: "BRAVE_API_KEY", placeholder: "BSA..." }],
    tags: ["search", "web"],
  },
  {
    id: McpServerId.make("slack"),
    name: "Slack",
    descriptionEn: "List channels, read threads, and post messages to your Slack workspace.",
    descriptionRu: "Чтение каналов и тредов, отправка сообщений в рабочее пространство Slack.",
    category: "productivity",
    homepageUrl: "https://github.com/modelcontextprotocol/servers",
    authHint: "api-key",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
    },
    requiredSecrets: [
      { key: "SLACK_BOT_TOKEN", placeholder: "xoxb-..." },
      { key: "SLACK_TEAM_ID", placeholder: "T01234567" },
    ],
    tags: ["chat", "team", "messaging"],
  },
  {
    id: McpServerId.make("firecrawl"),
    name: "Firecrawl",
    descriptionEn: "Scrape, crawl, and extract structured data from websites.",
    descriptionRu: "Парсинг, краулинг и извлечение структурированных данных с сайтов.",
    category: "browser",
    homepageUrl: "https://docs.firecrawl.dev/mcp-server",
    authHint: "api-key",
    transport: { type: "stdio", command: "npx", args: ["-y", "firecrawl-mcp"] },
    requiredSecrets: [{ key: "FIRECRAWL_API_KEY", placeholder: "fc-..." }],
    tags: ["scraping", "crawl", "web"],
  },
];

export function catalogEntryToMcpServerConfig(entry: McpCatalogEntry): McpServerConfig {
  return {
    name: entry.name,
    enabled: true,
    transport:
      entry.transport.type === "http"
        ? { type: "http", url: entry.transport.url, headers: {} }
        : {
            type: "stdio",
            command: entry.transport.command,
            args: [...entry.transport.args],
            env: {},
            cwd: "thread",
          },
  };
}
