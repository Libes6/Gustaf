# Админ-панель Gustaf

Админка находится в `apps/admin` (React + Vite, пакет `@gustaf/admin`). Это статический
SPA: весь доступ к данным идёт в облачный API (`apps/api`) через `/v1/me` и `/v1/admin/*`
с cookie-сессией Better Auth. Вход только через GitHub; панель открывается пользователям
с ролью `admin`, остальные видят экран «No access».

## Локально

```sh
pnpm install
cd apps/admin
cp .env.example .env.local   # VITE_API_URL, по умолчанию https://api.libes6.ru
vp test run
vp build
```

`VITE_API_URL` читается при сборке. Cookie сессии ставит API, поэтому админка и API
должны быть на одном сайте (`*.libes6.ru`); с `localhost` против боевого API вход не
заработает, нужен локальный API с `ADMIN_ORIGIN=http://localhost:<порт>`.

## Образ

Из корня: `docker build -f apps/admin/Dockerfile --build-arg VITE_API_URL=https://api.libes6.ru -t gustaf-admin:local .`

Сборка запускает unit-тесты и `vite build`, затем `nginx:alpine` отдаёт `dist` на порту 80:
fallback на `index.html` для клиентских маршрутов, `immutable` кэш для `/assets/*`,
`no-cache` для `index.html`, `GET /healthz` для проверки. Заголовки: CSP без inline
скриптов, `connect-src` разрешает только origin из `VITE_API_URL` (подставляется при
сборке), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. Смена адреса API
требует пересборки образа.

Workflow `Gustaf Admin` (`.github/workflows/admin.yml`) собирает и проверяет образ в PR,
при push в `dev` публикует `ghcr.io/libes6/gustaf/admin:sha-<полный SHA>`.

## Размещение в Coolify

1. DNS: A-запись `admin.libes6.ru` на IP VPS (см. [cloud-api.md](cloud-api.md)).
2. В проекте `Gustaf / production` создать Docker Image application `gustaf-admin`,
   image `ghcr.io/libes6/gustaf/admin`, tag из успешного workflow. Доступ к GHCR —
   как у API.
3. Ports Exposes: `80`; домен `https://admin.libes6.ru` с target port 80. Host port
   mapping не нужен. Runtime-переменные образу не нужны.
4. Healthcheck: GET `/healthz`, порт 80, код 200.
5. Deploy, затем открыть `https://admin.libes6.ru`.

## Настройки API

В приложении `gustaf-cloud-api` задать и передеплоить:

- `ADMIN_ORIGIN=https://admin.libes6.ru` — origin админки для CORS с credentials и как
  разрешённый callback входа.
- `ADMIN_GITHUB_LOGINS` — GitHub-логины через запятую, которые получают роль `admin`.

Необязательные переменные для страниц «Система» и «Релизы» (без них соответствующий блок
показывает «не настроено» или ошибку, остальное работает):

- `COOLIFY_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_DATABASE_UUID` — последний бэкап PostgreSQL.
  Токен создать в Coolify → Keys & Tokens → API tokens только с правом `read` (без
  `read:sensitive`, `write`, `deploy`); это не тот `COOLIFY_TOKEN`, что у деплоя из Actions.
  UUID — у ресурса PostgreSQL в Coolify (в URL страницы базы). API access в Coolify должен
  быть включён. Ответ кешируется на 10 минут.
- `GITHUB_TOKEN` — fine-grained token без прав (только публичные репозитории), поднимает
  лимит GitHub API для скачиваний релизов. Ответ кешируется на час.

Диск на странице «Система» — `statfs /` внутри контейнера, то есть диск хоста, который
видит контейнер. Счётчики релея «с запуска» живут в памяти процесса и обнуляются при
рестарте; дневные — в таблице `relay_daily` (только агрегаты, без пользователей и адресов).

Admin-эндпоинты реализует API отдельно; панель опирается на контракт из
`apps/admin/src/api/client.ts` (единственное место с HTTP-деталями).

## Деплой из Actions

В GitHub добавить repository variable `COOLIFY_ADMIN_APP_UUID` — UUID приложения
`gustaf-admin`. Deploy-job использует environment `cloud-production` с уже
настроенными `COOLIFY_URL` и секретом `COOLIFY_TOKEN`. Пока переменная не задана,
job печатает notice и пропускает деплой без ошибки. Откат: выбрать предыдущий SHA tag
в Coolify и выполнить Deploy.
