# Локальная разработка облачного API Gustaf

Облачный API находится в `apps/api`. Существующий `apps/server` — сервер на
компьютере пользователя; он продолжает работать независимо. Старый `infra/relay`
не разворачивается этим приложением. Существующие cloud-клиенты пока не переключены.

Используйте Node и pnpm из корневого `package.json`. Из корня репозитория:

```sh
pnpm install
cp apps/api/.env.example apps/api/.env
docker compose -p gustaf-cloud-dev -f apps/api/compose.yaml up -d --wait
pnpm --filter @gustaf/api build
pnpm --filter @gustaf/api db:migrate
pnpm --filter @gustaf/api start
```

API слушает `127.0.0.1:3100`. `/health/live` проверяет процесс, `/health/ready`
проверяет запрос к PostgreSQL и возвращает 503 при ошибке. Readiness не подтверждает
наличие будущих предметных таблиц. Схема пока пустая: auth выбирается следующим этапом.
Миграционный runner создаёт только служебный журнал Drizzle.

Для разработки в двух терминалах: `pnpm --filter @gustaf/api dev` компилирует
изменения; `pnpm --filter @gustaf/api start:watch` перезапускает собранный сервер.
Перед первым запуском выполните build. Изменения env требуют перезапуска процесса.

```sh
pnpm --filter @gustaf/api typecheck
pnpm --filter @gustaf/api build
pnpm --filter @gustaf/api test
TEST_DATABASE_URL=postgresql://gustaf:gustaf_local@127.0.0.1:55432/gustaf_cloud pnpm --filter @gustaf/api test:integration
```

Integration проверяет настоящий PostgreSQL и пишет служебный журнал миграций;
используйте только локальную одноразовую базу. Compose публикует базу на loopback
порту 55432. Учётные данные в примере предназначены только для локальной разработки.
Остановка без удаления данных:

```sh
docker compose -p gustaf-cloud-dev -f apps/api/compose.yaml down
```

После добавления таблиц в `src/**/*.schema.ts`: `pnpm --filter @gustaf/api db:generate`, проверить SQL,
собрать API и выполнить `db:migrate` отдельным шагом перед запуском новой версии.
Миграции не запускаются автоматически каждым API-процессом. Таблицы появятся вместе с первым предметным модулем.

## Docker и GitHub Actions

Из корня: `docker build -f apps/api/Dockerfile -t gustaf-api:local .`.
Docker использует общий frozen lockfile и отдельный список разрешённых файлов
контекста; .env и остальные приложения не копируются. Runtime работает от
пользователя node, слушает `0.0.0.0:3100`, имеет readiness healthcheck.

Проверка образа с одноразовой базой:

```sh
docker compose -p gustaf-cloud-image-test -f apps/api/compose.image-test.yaml up -d --wait --wait-timeout 90
docker compose -p gustaf-cloud-image-test -f apps/api/compose.image-test.yaml exec -T api node dist/database/migrate.js
docker compose -p gustaf-cloud-image-test -f apps/api/compose.image-test.yaml down --volumes
```

Workflow `Gustaf Cloud API` проверяет образ в PR. При push в `dev`, `gustaf/cloud-api-foundation` и ручном запуске
публикует проверенный образ `ghcr.io/libes6/gustaf/cloud-api:sha-<полный SHA>`.
GitHub runner выпускает linux/amd64; подтвердите эту архитектуру у VPS.
Десктоп и мобильные release workflows не изменены. Этот workflow не следует
назначать обязательным repo-wide check: он фильтруется по путям и пропускает
несвязанные PR. Общий CI gate следует настраивать отдельно.

## Первый staging в Coolify

1. У DNS-провайдера домена `libes6.ru` добавить A-записи `coolify`, `api`, `admin`
   на публичный IP VPS. На момент настройки по скриншоту это `83.141.74.125`.
   Проверить IP и DNS, открыть TCP 80/443 для proxy.
2. В Settings → General настроить URL `https://coolify.libes6.ru`, проверить HTTPS.
3. В проекте создать PostgreSQL 17 с persistent volume. Не включать публичный
   порт базы. Сохранить внутренний URL и настроить отдельные внешние backups.
4. Создать Docker Image application `gustaf-cloud-api`, image
   `ghcr.io/libes6/gustaf/cloud-api`, tag из успешного workflow. API и PostgreSQL
   должны иметь сетевую связность; использовать внутреннее DNS-имя базы.
5. Если GHCR package закрытый, настроить на deployment server доступ к registry
   с read:packages. Не использовать GitHub Actions GITHUB_TOKEN как постоянный пароль.
6. Ports Exposes: `3100`; домен `https://api.libes6.ru` с target port 3100.
   DATABASE_URL — внутренний URL базы; HOST=0.0.0.0, PORT=3100.
   Не создавать host port mapping 3100: наружу приложение отдаёт proxy.
7. Healthcheck: GET `/health/ready`, порт 3100, ожидаемый код 200.
8. Выполнить Deploy, проверить выбранный SHA в логах деплоя и
   `https://api.libes6.ru/health/ready`. В терминале приложения можно выполнить
   `node dist/database/migrate.js`; сейчас он создаёт только служебный журнал.

Для последующих релизов с предметными миграциями понадобится отдельный шаг
миграций из нового образа до его запуска. Текущий workflow не запускает миграции
на VPS. До добавления auth-таблиц это не мешает работе каркаса.

Для деплоя из Actions создать GitHub Environment `cloud-staging`:

- Variable `COOLIFY_URL`: `https://coolify.libes6.ru` без `/api/v1`.
- Variable `COOLIFY_APP_UUID`: UUID только приложения API.
- Secret `COOLIFY_TOKEN`: Coolify API token с правами изменения приложения и Deploy.

В Coolify включить API access. Actions сначала PATCH-ит repository/tag приложения,
затем вызывает GET `/api/v1/deploy?uuid=...`. Настроить environment approvals при
необходимости. Push в `dev` после проверок автоматически запускает деплой. При ручном запуске
с ветки `dev` нужен флаг deploy. Из рабочей ветки публикуется только образ для
первичной настройки; первый деплой запускается отдельно через Coolify API.

Успех job deploy означает, что Coolify принял запрос, а не что контейнер уже
готов: завершение проверяется в Coolify и через readiness. При ошибке запроса
конфигурация tag могла уже измениться; проверить её перед повтором.
Для отката выбрать предыдущий SHA tag в Coolify и выполнить Deploy.

Админки пока нет: DNS admin резервирует адрес, но приложение ещё не развёрнуто.
Деплой на VPS и запуск workflow из этой рабочей ветки пока не выполнялись.
