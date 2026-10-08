# PROJECT HANDOFF — evgeny-portfolio-timeweb

Постоянный технический handoff-документ проекта. Цель: если текущая сессия/чат потеряны, новый ИИ-агент открывает этот файл и за один проход понимает, что это за проект, из чего он состоит, что уже реализовано, что в production, что нельзя ломать и как безопасно продолжать работу.

Документ описан на основе прямого чтения кода, тестов, README и истории git на момент снимка — не по памяти и не по старым предположениям.

**Это единственный handoff-документ репозитория.** В репозитории два крупных продукта — Portfolio (сайт-визитка) и TerraIntel — и один набор общей инфраструктуры, на которой они оба работают. Чтобы не плодить конфликтующие источники истины, всё описано в этом одном файле, с чёткой маркировкой, к чему относится каждый раздел:

| № | Раздел | К чему относится |
|---|---|---|
| 1 | Состояние репозитория | Shared |
| 2 | Общая архитектура | Shared (фиксирует именно границу Portfolio / TerraIntel / Shared) |
| 3 | Portfolio | **Portfolio** |
| 4 | TerraIntel | **TerraIntel** |
| 5 | Certificates | Shared-инфраструктура, но фича только Portfolio (TerraIntel её не использует) |
| 6 | Projects / Supabase | Shared-инфраструктура, но фича только Portfolio |
| 7 | Contact / Telegram | Shared-инфраструктура (`server.js`), фича только Portfolio |
| 8 | Portfolio AI | Shared-инфраструктура (`server.js`), фича только Portfolio; не путать с TerraIntel AI (раздел 4) |
| 9 | Routes | Shared (таблица помечает модуль каждого маршрута) |
| 10 | Environment variables | Shared (таблица сгруппирована по модулю) |
| 11 | Production / Timeweb | **Shared** — один процесс, один деплой на оба продукта |
| 12 | Tests | Shared (список файлов помечает, к какому модулю относится каждый) |
| 13 | Safety / Security | Shared, с отдельным пунктом про TerraIntel-specific safety (forbidden claims) |
| 14 | Критичные защищённые области | Явно разбито по Portfolio / TerraIntel / Certificates / Projects / Shared |
| 15 | Development workflow | **Shared** |
| 16 | Known tech debt | Смешанный — каждая строка таблицы сама по себе про Portfolio, TerraIntel или общую инфраструктуру |
| 17 | Roadmap | Смешанный, аналогично |
| 18 | START HERE | Сводка фактов по всем трём группам |

Коротко: **Portfolio** — это всё в `public/index.html` + `lib/certificates.js` + `lib/projects.js` + инлайн-роуты `server.js` (`/api/contact`, `/api/ai`). **TerraIntel** — полностью изолированный модуль (`public/terraintel/**`, `lib/terraintel.js`, `/api/terraintel/*`), не делит код ни с чем, кроме самого Express-процесса. **Shared infrastructure** — сам `server.js` (монтирование роутеров, `helmet`, статика), Timeweb Cloud App Platform как единственная точка деплоя на оба продукта, и общий `npm test`.

---

## 1. Состояние репозитория (снимок)

| Параметр | Значение |
|---|---|
| Repository | `Supaplex777/evgeny-portfolio-timeweb` |
| Branch (снимок сделан от) | `main` |
| Актуальный SHA `main` | `9b3101b5a9a60ec46e5c04647948c03665b705e8` (merge PR #26) |
| Дата снимка | 2026-10-08 |
| Node.js | `>=20` (`package.json engines`); в окружении, где собран этот снимок, установлен Node v22.22.2 |
| Package manager | npm (`package-lock.json` в репозитории) |
| Test command | `npm test` → `node --test test/*.test.js` (без доп. зависимостей, без реальной сети) |
| Текущее количество тестов | **94/94 passing** (проверено непосредственно перед написанием документа) |
| Production hosting | Timeweb Cloud App Platform |
| Production URL | `https://supaplex777-evgeny-portfolio-timeweb-1140.twc1.net/` |
| Health route | `GET /health` → `{status:"ok", uptime, timestamp}` |

**Важно:** эта песочница не может достучаться до `*.twc1.net` (egress заблокирован политикой сети контейнера), поэтому реальное состояние production **не верифицировано напрямую** в рамках подготовки этого документа — только код на `main`. Любой агент, перед тем как делать выводы о проде, должен либо получить доступ, либо явно попросить пользователя проверить вручную.

---

## 2. Общая архитектура

Весь проект — **одно Express-приложение** (`server.js`), которое раздаёт статику и держит несколько независимых API-роутеров. Единого фреймворка на фронтенде нет — это серверный монолит + несколько самодостаточных HTML-файлов с инлайновыми CSS/JS.

```
evgeny-portfolio-timeweb/
├── server.js                      # Express: /, /health, /api/contact, /api/ai, монтирует роутеры ниже
├── package.json / package-lock.json
├── .env.example                   # шаблон переменных окружения
├── README.md                      # частично устарел — см. раздел 19
├── lib/
│   ├── terraintel.js              # TerraIntel AI backend — полностью независим
│   ├── certificates.js            # Certificates backend + общие S3/session примитивы
│   └── projects.js                # Projects backend (переиспользует S3-клиент и сессию из certificates.js)
├── public/
│   ├── index.html                 # ~3550 строк: Portfolio целиком (Home/About/Projects/Skills/
│   │                               #   Certificates/Contacts/AI-панель/Legal) в одном файле
│   ├── certificates-rotate.js     # отдельный хелпер поворота превью при загрузке сертификата
│   ├── assets/                    # WebP-изображения (hero, about, сертификаты, контакты и т.д.)
│   └── terraintel/
│       ├── index.html             # отдельный фронтенд TerraIntel (самодостаточный файл)
│       └── vendor/                # локальная копия MapLibre GL JS 5.7.1 (BSD-3, вендоринг)
├── scripts/
│   ├── migrate-certificates.js    # одноразовый скрипт миграции Supabase → S3 (сертификаты)
│   └── seed-resellflow.js         # идемпотентный сидер карточки проекта ResellFlow
├── supabase/
│   └── projects_contacts.sql      # legacy SQL-схема, оставлена только для истории, кодом не читается
└── test/
    ├── certificates.test.js
    ├── certificates-rotate.test.js
    ├── contact.test.js
    ├── projects.test.js
    ├── seed-resellflow.test.js
    ├── skills-public-admin.test.js
    ├── terraintel.test.js
    └── helpers/
```

### Что независимо, а что общее

- **TerraIntel** (`public/terraintel/**`, `lib/terraintel.js`, `/terraintel/`, `/api/terraintel/*`) — полностью отдельное приложение внутри того же процесса. Общий только Express-процесс и глобальный `helmet`/статика. Свой AI-промпт, своя модель (`sber/gigachat-2`), свои лимиты, свой фронтенд. Не использует Projects/Certificates/Skills/Contact код и наоборот.
- **Portfolio** (главный сайт: Home/About/Projects/Skills/Certificates/Contacts/AI-ассистент/Legal) — весь живёт в одном файле `public/index.html`, переключение разделов — через CSS `:target` по hash-навигации (`#about`, `#projects`, `#skills`, `#certificates-page` и т.д.), без перезагрузки страницы.
- **Certificates** и **Projects** — два разных backend-модуля (`lib/certificates.js`, `lib/projects.js`), но физически используют **один и тот же** бакет Timeweb S3 и **одну и ту же** owner-сессию (cookie `cert_admin`, `Path=/api`), различаясь только префиксом ключей в S3.
- **Contact/Telegram** и **AI-ассистент портфолио** (`/api/contact`, `/api/ai`) реализованы инлайн прямо в `server.js`, отдельных `lib/`-модулей для них нет.
- **Skills** — единственный раздел вообще без backend: данные живут только в `localStorage` браузера посетителя (подробности в разделе 3).

### Где что хранится

| Данные | Где хранятся |
|---|---|
| Сертификаты (метаданные, файлы, превью) | Timeweb S3, бакет `S3_BUCKET_CERTIFICATES`, префиксы `originals/`, `previews/`, `metadata/` |
| Проекты портфолио (метаданные, обложки, галерея) | тот же бакет Timeweb S3, префикс `projects/` |
| Навыки (Skills) | `localStorage` браузера посетителя, ключ `evgeny-portfolio-skills-v1`; ничего не уходит на сервер |
| Owner-сессия (админ-вход) | подписанная HMAC-SHA256 cookie `cert_admin`, без серверного session-store |
| Заявки с контактной формы | не хранятся в БД — только пересылаются в Telegram (обязательно) и опционально на email через Resend; есть временная in-memory защита от дублей (10 минут, в памяти процесса) |
| Проект TerraIntel (CSV, результат анализа) | только `localStorage` браузера посетителя TerraIntel (см. раздел 4) — backend ничего не хранит |

---

## 3. PORTFOLIO (главный сайт)

Один файл `public/index.html`, роутинг разделов через CSS `:target` + hash-навигацию, оверлейные (`position:fixed`) «страницы» со своим внутренним скроллом.

**Разделы:**
- **Home / Hero** — приветственный экран с hero-изображением (WebP), анимированным меню и CTA.
- **About («Обо мне»)** — интерактивная панель с несколькими состояниями.
- **Projects («Проекты»)** — карточки проектов, читаются из `GET /api/projects` (backend на Timeweb S3, см. раздел 6); для владельца (`?admin=1` + валидная сессия) доступны создание/редактирование/удаление и загрузка галереи. На фронтенде есть два захардкоженных fallback-объекта (TerraIntel и временно — ResellFlow), которые подставляются, пока в backend нет реальной записи с соответствующим слагом/названием — это чисто фронтенд-заглушки, не путать с самим приложением TerraIntel.
- **Skills («Навыки»)** — секция `<section id="skills">`, данные только в `localStorage`, backend отсутствует полностью (подробнее — раздел «известные особенности» ниже).
- **Certificates («Сертификаты»)** — карточки по категориям (`ai`/`code`/`data`/`test`/`basic`/`new`), читаются из `GET /api/certificates`; для владельца доступны загрузка/редактирование/удаление/поворот превью.
- **Contacts («Контакты»)** — форма, отправляющая `POST /api/contact` (раздел 7).
- **AI-ассистент портфолио** — плавающая кнопка (`#evg-ai-launch`) открывает панель `#evg-ai-panel`, общение через `POST /api/ai` (раздел 8).
- **Legal/Privacy** — отдельная `:target`-страница с политикой.

**Responsive-поведение:** burger-меню на мобильных, touch-таргеты ≥44px, `env(safe-area-inset-*)`, `100dvh`+`visualViewport` для клавиатуры на мобильных, `@media(hover:hover) and (pointer:fine)` для hover-эффектов только на устройствах с мышью, `@media(prefers-reduced-motion:reduce)`, брейкпоинты `max-width:900px` (мобильный/планшет), `max-width:520px` (маленький телефон), `min-width:1700px` (широкий десктоп). Это результат отдельного прохода по мобильной адаптации (см. историю PR в разделе 16) — любое новое изменение фронтенда стоит проверять на мобильной и десктопной ширине отдельно.

**[ВАЖНАЯ ОСОБЕННОСТЬ — Skills]** У раздела «Навыки» **нет backend вообще**: ни одного роута `/api/skills` нигде в проекте не существует (подтверждено и грепом, и отдельным тестом `test/skills-public-admin.test.js`). Кнопка «Редактировать» видна только при `?admin=1` (чисто фронтенд-флаг, независимо вычисляемый прямо в IIFE этого раздела) и защищена на нескольких уровнях (атрибут `hidden`, проверки внутри `mode()`/обработчика клика/`save()`, повторное применение гейта на событии `pageshow` — на случай восстановления страницы из bfcache в Safari/Firefox без повторного выполнения скрипта). Любое «сохранение» как админ пишет только в `localStorage` этого конкретного браузера — никогда не попадает на сервер и не видно другим посетителям или реальному владельцу удалённо. Это исторически было реальной уязвимостью (кнопка редактирования была видна и работала для любого посетителя) — исправлено, тест закрепляет инвариант.

---

## 4. TerraIntel — модульная интеллектуальная платформа анализа геопространственных и сенсорных данных

Отдельное учебное приложение внутри того же Express-процесса: `public/terraintel/index.html` (фронтенд) + `lib/terraintel.js` (backend, роут `/api/terraintel/analyze`).

### [РЕАЛИЗОВАНО]

- **Поток CSV → обнаружение аномалий → карта → ИИ-интерпретация → отчёт**, целиком работающий end-to-end для **магнитометрии + GPS/ГЛОНАСС**.
- **Парсинг CSV** — собственный парсер с поддержкой кавычек, автоопределением разделителя (`,`/`;`/таб), делается **полностью в браузере**; сырые CSV на сервер никогда не уходят.
- **Обнаружение аномалий (Robust Z)**: медиана и MAD (median absolute deviation) по магнитометрическим значениям, `robust_z = 0.67449 × (value − median) / MAD`; локальные пики по модулю Robust Z выше порога, сортировка по убыванию, ограничение — до 20 кандидатов на запрос.
- **Синхронизация GPS/магнитометра**: при наличии временных меток — доля точек магнитометра, попадающих в GPS-фиксацию в пределах 2 медианных интервалов GPS; без временных меток — честно показывается «не рассчитано» (сопоставление по порядку строк), а не выдуманное число.
- **Карта**: MapLibre GL JS 5.7.1, локально завендоренная в `public/terraintel/vendor/` (лицензия BSD-3), тайлы — MapTiler по клиентскому ключу (`TERRAINTEL_MAPTILER_KEY` зашит прямо в JS — это ожидаемо для доменно-ограниченных MapTiler-ключей, но стоит проверять в кабинете MapTiler, что домен-рестрикция реально настроена).
- **ИИ-интерпретация**: same-origin запрос `POST /api/terraintel/analyze` (никакого CORS и Cloudflare Worker, всё внутри одного процесса); на сервер уходят только подготовленные поля аномалии (`id`, `lat`, `lon`, `robust_z`, `sample_index`, `timestamp`) — whitelist на уровне `validatePayload`, любые другие поля отбрасываются. Используется Polza AI, модель `sber/gigachat-2` (управляется `TERRAINTEL_MODEL`), независимый от портфолио-ассистента системный промпт.
- **Human-in-the-loop / safety**: отдельный системный промпт прямо запрещает модели утверждать обнаружение мин/оружия/боеприпасов или объявлять территорию безопасной; сервер дополнительно фильтрует такие утверждения регулярным выражением `FORBIDDEN_CLAIMS` и отбрасывает их на бэкенде независимо от того, что вернула модель; каждая рекомендация явно требует экспертной проверки специалистом.
- **Fallback при недоступности ИИ**: если Polza недоступна/вернула некорректный JSON — найденные локально аномалии всё равно сохраняются с нейтральным локальным объяснением на фронтенде, пользователь видит причину («AI-интерпретация недоступна»).
- **Защита расходов**: отдельный rate limit по IP (`TERRAINTEL_RATE_LIMIT`, по умолчанию 10/15 мин), общий дневной бюджет на процесс (`TERRAINTEL_DAILY_LIMIT`, по умолчанию 200/сутки, in-memory — обнуляется при рестарте), таймаут запроса к Polza (`TERRAINTEL_TIMEOUT_MS`, по умолчанию 30000 мс), лимит 20 аномалий и 64 КБ на тело запроса.
- **Отчёт/«PDF»**: генерируется как HTML и открывается в новой вкладке, «сохранение в PDF» — через системный диалог печати браузера (`window.print()`); отдельного серверного PDF-генератора нет. Также доступны экспорт в CSV и GeoJSON.
- **Тесты backend**: `test/terraintel.test.js` — валидация payload, whitelist полей, коды ошибок (400/413/429/502/504), фильтрация небезопасных утверждений модели, устойчивость парсинга JSON-ответа модели к markdown-обёртке.

### [ЧАСТИЧНО / НЕСООТВЕТСТВИЕ МАКЕТА РЕАЛЬНОСТИ]

- Лендинг TerraIntel и личный кабинет **визуально обещают 5 сенсоров** (LiDAR, тепловизор, RGB-камера, магнитометр, GPS/ГЛОНАСС) и полноценную многопроектную SaaS-платформу (сайдбар «Мои проекты», «Архив», «Источники данных», «Центр данных», «Настройки», пагинация и т.д.). **Реально работает только связка магнитометрия + GPS/ГЛОНАСС**; разделы «Архив», «Источники данных», «ИИ-анализ» (как отдельная страница), «Центр данных», «Настройки» в сайдбаре — это заглушки, открывающие модалку «раздел в разработке», без какой-либо функциональности.
- **Хранение проекта — не многопроектное**: несмотря на весь интерфейс «моих проектов», данные хранятся **только в `localStorage`** одним объектом (ключ вида `terraintel_mvp_project_v13`), новый анализ **молча перезаписывает** предыдущий без подтверждения. Нет backend-БД, нет реальных аккаунтов — «Евгений Смирнов — Владелец проекта» в сайдбаре это статичный текст, не сессия.
- В HTML лендинга TerraIntel вшита base64-картинка (~2.6 МБ) прямо в `<style>` как `background-image` — не вынесена в отдельный WebP-файл, как это сделано для hero-изображения на главном сайте. Существенно утяжеляет каждую загрузку `/terraintel/`.
- Фронтенд-логика обнаружения аномалий (`terraDetect`, парсер CSV, расчёт синхронизации) **не покрыта тестами вообще** — тесты существуют только для backend (`lib/terraintel.js`). Вся расчётная математика (Robust Z, пикдетекция) живёт непротестированной внутри `public/terraintel/index.html`.

### [ПЛАН]

- LiDAR/тепловизор/RGB-камера — заявлены в UI и на лендинге как видение продукта, в коде отсутствуют полностью. Любая работа над ними — это новая фича, а не доработка существующего, и должна восприниматься именно так.
- Многопроектность, реальные аккаунты, «Архив», «Источники данных», «Центр данных», «Настройки» — заявлены в интерфейсе, не реализованы нигде.

### Env и маршруты TerraIntel

См. таблицы в разделах 10 и 11.

---

## 5. CERTIFICATES

- Backend: `lib/certificates.js`, монтируется в `server.js` на `/api/certificates`.
- **Supabase здесь больше не используется.** Хранение — Timeweb Cloud S3 (`@aws-sdk/client-s3`, `forcePathStyle: true`), один S3-клиент на процесс (`createS3Client()` — модульный синглтон, раньше создавался заново на каждый вызов — оптимизировано в PR #26).
- Структура в S3: оригинал файла (`originals/<category>/<id>/<filename>`), превью WebP (`previews/<category>/<id>.webp`), JSON-метаданные (`metadata/<category>/<id>.json`) — нет управляемой БД, метаданные — это сами JSON-файлы в бакете.
- Категории: `ai`, `code`, `data`, `test`, `basic`, `new`.
- **Auth владельца**: `POST /api/certificates/login` — bcrypt-сравнение пароля с `ADMIN_PASSWORD_HASH` (никогда не хранится в виде открытого текста), при успехе выставляется подписанная HMAC-SHA256 cookie (`cert_admin`, `Path=/api`, `HttpOnly`, `SameSite=Strict`, `Secure`, TTL 24 часа). `GET /api/certificates/session` сообщает, авторизован ли текущий запрос.
- Все мутирующие роуты (`POST /`, `PATCH /:id`, `DELETE /:id`) защищены связкой `requireSameOrigin` (проверка Origin/Referer против `CERT_ALLOWED_ORIGIN`) + `requireOwnerSession` (валидная cookie) → без валидной сессии ответ `401`.
- **Upload/edit/delete/rotate**: загрузка файла + опционального превью (`multer`, память, лимит `CERT_MAX_FILE_SIZE_MB`, по умолчанию 15 МБ); `PATCH` обновляет заголовок/описание/превью; `DELETE` удаляет метаданные + оригинал + превью одним запросом к S3; поворот превью при загрузке реализован отдельным клиентским хелпером `public/certificates-rotate.js` (чистые функции, протестированы в `test/certificates-rotate.test.js`).
- **AI-контекст**: `getCertificatesSummaryForAI()` формирует сводку сертификатов для ассистента портфолио (раздел 8); с PR #26 результат кэшируется на 60 секунд (`AI_SUMMARY_CACHE_TTL_MS`), кэш явно инвалидируется (`invalidateAiSummaryCache()`) сразу после успешного создания/обновления/удаления сертификата — чтобы владелец не ждал до минуты, чтобы увидеть правку в ответах ассистента.
- **История миграции**: было Supabase → теперь собственный backend на Timeweb S3 (миграция зафиксирована в `scripts/migrate-certificates.js` — однократный read-only скрипт переноса, читает из Supabase, пишет в S3, ничего не трогает в Supabase).

---

## 6. PROJECTS / Supabase

**Факт по актуальному `main`: Supabase для раздела «Проекты» больше НЕ используется.** Это могло быть не так на более ранних этапах разработки (и ранее один из разговоров с пользователем предполагал, что миграция Projects с Supabase — это ещё предстоящая отдельная задача), но на снимке `9b3101b5...` раздел уже полностью мигрирован.

- Backend: `lib/projects.js`, монтируется на `/api/projects`.
- Хранение: **тот же самый** бакет Timeweb S3, что и Certificates (`S3_BUCKET_CERTIFICATES`, тот же `createS3Client()`), но под отдельным префиксом ключей `projects/metadata/<id>.json`, `projects/originals/<id>/cover.webp`, `projects/originals/<id>/gallery/<imageId>.webp` — отдельного S3-бакета для проектов нет.
- Одна JSON-запись на проект (id — UUID), без управляемой БД.
- Поля: `title`, `slug` (генерируется из `title`), `summary`, `description`, `goal`, `result`, `status` (`В разработке`/`MVP`/`Завершён`/`Активный`), `category` (`ai`/`automation`/`web`/`data`/`other`), `tags`, `cover_url` (WebP), `project_url`/`github_url`/`demo_url`, `published` (черновики скрыты от публичных запросов, видны владельцу), галерея (до 8 изображений).
- Auth мутирующих роутов — **переиспользует** `requireSameOrigin`/`requireOwnerSession`/`verifySession`/`parseCookies` прямо из `lib/certificates.js` (один и тот же логин, одна cookie на оба модуля).
- Что ещё относится к Supabase как legacy-зависимости, не путать с Projects:
  - `scripts/migrate-certificates.js` — читает из Supabase (переменные `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`), но это касается **Certificates**, не Projects, и это read-only одноразовый скрипт.
  - `supabase/projects_contacts.sql` — legacy SQL-схема в репозитории, оставлена для истории, не читается никаким работающим кодом.
  - В `public/index.html` остались два **неактивных** упоминания Supabase: explaining-комментарий о том, что блокирующий `<script>`-тег Supabase SDK был удалён (это и был фикс реального продакшен-бага — см. раздел 9), и строка `'Supabase'` внутри тегов захардкоженной fallback-карточки TerraIntel в разделе «Проекты» — это просто текстовая метка на карточке-заглушке, не реальная зависимость.

**Вывод для нового агента:** если задача формулируется как «мигрировать Projects с Supabase» — такая задача уже выполнена, сначала проверьте код, не начинайте миграцию заново.

---

## 7. CONTACT / Telegram

Реализовано инлайн в `server.js`, роут `POST /api/contact`.

- **Валидация**: `name` ≥ 2 символов, `contact` ≥ 3 символов, `message` ≥ 10 символов, `project_type` опционален; все текстовые поля чистятся от управляющих символов и обрезаются по максимальной длине.
- **Honeypot**: скрытое поле `company` — если заполнено, боту тихо возвращается `204` без какой-либо отправки.
- **Rate limit**: 5 запросов / 15 минут с одного IP (`express-rate-limit`).
- **Duplicate protection**: in-memory фингерпринт (`ip|name|contact|message`), окно 10 минут → повтор получает `409`; фингерпринт фиксируется **только после успешной** отправки в Telegram, чтобы неудачная попытка не блокировала немедленный повторный ввод.
- **Telegram Bot API — обязательный основной канал**: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. Сообщение отправляется **без `parse_mode`** (plain text) — это намеренная защита от инъекций разметки через то, что ввёл посетитель формы, а не просто санитизация. Если токен/chat id не настроены — сервер **честно возвращает `500`**, а не притворяется, что заявка отправлена.
- **Таймаут** запроса к Telegram API — 8 секунд (`AbortSignal.timeout(8000)`).
- **Обработка ошибок**: различаются сетевые/таймаут-ошибки (`TimeoutError`/`AbortError`/`TypeError` → `503`, «Telegram временно недоступен») и HTTP-ошибки самого Telegram API (→ `502`). Токен и полный URL запроса **никогда не логируются** (URL содержит токен бота в пути).
- **Email через Resend — опциональный best-effort второй канал**: отправляется только **после** успешного Telegram, его собственная ошибка никогда не влияет на итоговый ответ формы. Управляется `RESEND_API_KEY` (или алиас `EMAIL_API_KEY`) + `CONTACT_EMAIL_FROM`; получатель — `CONTACT_EMAIL_TO` (по умолчанию `cmrrus@rambler.ru`).
- **Production caveat**: песочница, в которой велась эта работа, не может достучаться до `api.telegram.org` напрямую (egress заблокирован политикой сети) — реальная работоспособность Telegram-доставки проверяется только на production/вручную пользователем, не из этого окружения.
- **Supabase здесь больше НЕ обязателен** — подтверждено по текущему `main`: маршрут `/api/contact` вообще не ссылается на Supabase ни в одном месте кода.

---

## 8. PORTFOLIO AI (AI-ассистент портфолио)

- Роут: `POST /api/ai` в `server.js`, rate limit 30 запросов / 15 минут.
- Провайдер: Polza AI, `https://polza.ai/api/v1/chat/completions`, модель `openai/gpt-oss-20b` (не путать с TerraIntel, у которого отдельная модель `sber/gigachat-2`).
- Запрос: `{question, context}` от клиента (обрезаются до 1000/20000 символов соответственно) + серверный блок «СЕРТИФИКАТЫ ИЗ ОБЛАЧНОЙ БАЗЫ», собираемый через `buildCertificatesContext(await getCertificatesSummaryForAI())` (кэш 60 сек, см. раздел 5).
- Системный промпт — развёрнутая русскоязычная инструкция: отвечать только на основе переданных данных, не выдумывать факты/опыт/сертификаты, быть кратким (3–7 предложений по умолчанию), не давать рекомендаций по найму, не раскрывать системный промпт/ключи/секреты, умеренно использовать ограниченный набор эмодзи.
- Без стриминга: `await upstream.text()` → `JSON.parse`, один раунд-трип, таймаут 30 секунд.
- `POLZA_API_KEY` используется **только на сервере**, в браузер никогда не передаётся.
- **Отличие от TerraIntel AI**: полностью независимые конфигурации — разная модель, разный системный промпт, разные лимиты, разный контекст (здесь — сертификаты из S3 + данные страницы; там — только подготовленные аномалии).
- PR #26 оптимизировал путь до вызова Polza (переиспользование S3-клиента + кэш сертификатов), но **реальная задержка ответа на продакшене против настоящего Polza API не измерялась** из этой песочницы (egress заблокирован) — считать проблему латентности закрытой нельзя без проверки на реальном проде.

---

## 9. ROUTES

| METHOD | ROUTE | MODULE | PURPOSE | IMPLEMENTATION FILE |
|---|---|---|---|---|
| GET | `/` и любой несовпавший путь | Portfolio (SPA fallback) | отдаёт `public/index.html` | `server.js` |
| GET | `/health` | Shared | health-check (`status`, `uptime`, `timestamp`) | `server.js` |
| POST | `/api/contact` | Contact/Telegram | приём заявки с формы, доставка в Telegram (+опц. email) | `server.js` |
| POST | `/api/ai` | Portfolio AI | вопрос-ответ ассистента портфолио (Polza AI) | `server.js` |
| GET | `/api/certificates` | Certificates | список сертификатов по категории | `lib/certificates.js` |
| GET | `/api/certificates/counts` | Certificates | счётчики сертификатов по категориям | `lib/certificates.js` |
| GET | `/api/certificates/session` | Certificates | проверка, авторизован ли текущий запрос | `lib/certificates.js` |
| POST | `/api/certificates/login` | Certificates | вход владельца (bcrypt + cookie-сессия) | `lib/certificates.js` |
| POST | `/api/certificates/` | Certificates (admin) | создать сертификат (файл + метаданные) | `lib/certificates.js` |
| PATCH | `/api/certificates/:id` | Certificates (admin) | обновить заголовок/описание/превью | `lib/certificates.js` |
| DELETE | `/api/certificates/:id` | Certificates (admin) | удалить сертификат (метаданные+файл+превью) | `lib/certificates.js` |
| GET | `/api/projects` | Projects | список проектов (черновики видны только владельцу) | `lib/projects.js` |
| GET | `/api/projects/:id` | Projects | детали одного проекта | `lib/projects.js` |
| POST | `/api/projects/` | Projects (admin) | создать проект | `lib/projects.js` |
| PATCH | `/api/projects/:id` | Projects (admin) | обновить проект | `lib/projects.js` |
| DELETE | `/api/projects/:id` | Projects (admin) | удалить проект (+вся его галерея) | `lib/projects.js` |
| POST | `/api/projects/:id/gallery` | Projects (admin) | загрузить изображения в галерею (лимит 8) | `lib/projects.js` |
| DELETE | `/api/projects/:id/gallery/:imageId` | Projects (admin) | удалить одно изображение галереи | `lib/projects.js` |
| POST | `/api/terraintel/analyze` | TerraIntel | ИИ-интерпретация подготовленных аномалий | `lib/terraintel.js` |
| GET | `/terraintel/` (и файлы под `/terraintel/*`) | TerraIntel | статика фронтенда TerraIntel | `server.js` (`terraIntelPageHeaders`) + `public/terraintel/index.html` |

**Важно:** роута `/api/skills` не существует нигде — у Skills нет backend вообще (раздел 3).

---

## 10. ENVIRONMENT VARIABLES

Секретные значения не выводятся — только имена, назначение и статус обязательности.

### Portfolio (ядро)

| VARIABLE | MODULE | REQUIRED | DEFAULT | PURPOSE |
|---|---|---|---|---|
| `POLZA_API_KEY` | AI-ассистент портфолио (`/api/ai`) | да (иначе `/api/ai` отвечает 500) | — | ключ Polza AI, только на сервере |
| `PORT` | server.js | нет | `3000` | порт, на котором слушает Express |

### TerraIntel

| VARIABLE | MODULE | REQUIRED | DEFAULT | PURPOSE |
|---|---|---|---|---|
| `POLZA_API_KEY` | TerraIntel (`/api/terraintel/analyze`) | да (тот же ключ, что у Portfolio AI) | — | тот же ключ Polza AI используется и здесь |
| `TERRAINTEL_MODEL` | TerraIntel | нет | `sber/gigachat-2` | модель для интерпретации аномалий |
| `TERRAINTEL_RATE_LIMIT` | TerraIntel | нет | `10` | запросов с одного IP за 15 минут |
| `TERRAINTEL_DAILY_LIMIT` | TerraIntel | нет | `200` | общий дневной лимит AI-запросов (in-memory, сбрасывается по UTC-дате) |
| `TERRAINTEL_TIMEOUT_MS` | TerraIntel | нет | `30000` (диапазон 5000–60000) | таймаут запроса к Polza |

### Certificates / Projects (общий S3-бэкенд)

| VARIABLE | MODULE | REQUIRED | DEFAULT | PURPOSE |
|---|---|---|---|---|
| `S3_ENDPOINT` | Certificates + Projects | да | — | endpoint Timeweb Cloud S3 |
| `S3_REGION` | Certificates + Projects | нет | `ru-1` | регион S3 |
| `S3_BUCKET_CERTIFICATES` | Certificates + Projects | да | — | имя бакета (используется ОБОИМИ модулями, имя исторически про сертификаты) |
| `S3_ACCESS_KEY_ID` | Certificates + Projects | да | — | ключ доступа S3 |
| `S3_SECRET_ACCESS_KEY` | Certificates + Projects | да | — | секрет доступа S3 |
| `S3_PUBLIC_BASE_URL` | Certificates + Projects | да | — | публичный базовый URL для отдачи файлов из бакета |
| `CERT_ALLOWED_ORIGIN` | Certificates + Projects | да (иначе мутирующие роуты вернут 500) | — | допустимый Origin/Referer для `requireSameOrigin` (используется обоими модулями) |
| `CERT_MAX_FILE_SIZE_MB` | Certificates | нет | `15` | максимальный размер файла сертификата |
| `PROJECTS_MAX_FILE_SIZE_MB` | Projects | нет | `5` | максимальный размер обложки/изображения галереи проекта — **отсутствует в `.env.example`, известный пробел документации** |
| `ADMIN_PASSWORD_HASH` | Certificates + Projects (shared login) | да | — | bcrypt-хэш пароля владельца |
| `SESSION_SECRET` | Certificates + Projects (shared login) | да | — | секрет для подписи HMAC owner-сессии |

### Telegram / Email

| VARIABLE | MODULE | REQUIRED | DEFAULT | PURPOSE |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Contact | **да** (без него `/api/contact` вернёт 500) | — | токен Telegram-бота — основной обязательный канал |
| `TELEGRAM_CHAT_ID` | Contact | **да** | — | chat id получателя заявок |
| `RESEND_API_KEY` (или алиас `EMAIL_API_KEY`) | Contact | нет | — | ключ Resend для best-effort email-канала |
| `CONTACT_EMAIL_FROM` | Contact | нет (без него email просто не отправляется) | — | адрес отправителя (должен быть подтверждён в Resend) |
| `CONTACT_EMAIL_TO` | Contact | нет | `cmrrus@rambler.ru` | адрес получателя email-копии |

---

## 11. PRODUCTION / TIMEWEB

- Хостинг: **Timeweb Cloud App Platform**.
- Деплой — из ветки `main`.
- Start command: `npm start` (→ `node server.js`).
- Health check: `GET /health`.
- Production URL: `https://supaplex777-evgeny-portfolio-timeweb-1140.twc1.net/`.
- **Эта песочница не может достучаться до `*.twc1.net`** — egress заблокирован сетевой политикой окружения. Проверка реально задеплоенного коммита, работоспособности Telegram/AI на проде, задержки ответов — всё это нужно делать вручную владельцем или из окружения с доступом к сети, не отсюда.
- **Важно не превращать временный инцидент в постоянный факт**: в истории проекта была как минимум одна ситуация, когда после деплоя сайт временно не открывался у части пользователей — расследование (не из этой песочницы) показало, что причиной был синхронный блокирующий `<script>`-тег Supabase SDK в `<head>`, который мог зависать при недоступности `cdn.jsdelivr.net`; тег был удалён в рамках мобильного прохода по адаптивности. Это зафиксированная и исправленная история, а не текущая проблема — не стоит пересказывать её как актуальный открытый инцидент.
- Автодеплой при мерже в `main` ранее предполагался (по описанию в README), но прямого подтверждения автоматического редеплоя на Timeweb из этой песочницы получить нельзя — если задача требует уверенности в этом, стоит уточнить у пользователя или проверить в панели Timeweb.

---

## 12. TESTS

Команда: `npm test` → `node --test test/*.test.js`. Сеть и реальные ключи не нужны — все внешние вызовы (Polza AI, Telegram API, S3) подменяются заглушками/фейковыми клиентами.

| Файл | Что тестирует |
|---|---|
| `test/certificates.test.js` (самый большой) | публичные GET-роуты, логин/сессия владельца, 401 без сессии на всех мутирующих роутах, синглтон `createS3Client`, кэш `getCertificatesSummaryForAI` и его инвалидация при create/update/delete |
| `test/certificates-rotate.test.js` | чистые функции поворота превью (`normalizeRotation`, `isSwapped`, `rotatedCanvasSize`) |
| `test/contact.test.js` | валидация формы, honeypot, дедупликация, успешная/неуспешная доставка в Telegram (моки через `test/helpers/mock-fetch-preload.js`), коды 500/502/503/409 |
| `test/projects.test.js` | публичные GET-роуты, 401 без сессии на всех мутирующих роутах (включая PATCH/DELETE), валидация полей/категорий/статусов, лимит галереи (8 изображений), каскадное удаление, видимость черновиков только владельцу |
| `test/seed-resellflow.test.js` | идемпотентность скрипта `scripts/seed-resellflow.js` (повторный запуск не создаёт дубликат) |
| `test/skills-public-admin.test.js` | source-level проверки `public/index.html`: ADMIN-гейт существует, кнопка редактирования скрыта по умолчанию, защита на уровне функций, повторное применение гейта на `pageshow`, отсутствие дублирующего рендер-пути, отсутствие backend-роута у Skills |
| `test/terraintel.test.js` | валидация payload, whitelist полей к модели, коды ошибок (400/413/429/502/504), фильтрация небезопасных заявлений модели, устойчивость к markdown-обёртке в JSON-ответе |

**Актуальный результат:** 94/94 passing, проверено прямо перед подготовкой этого документа на `main` @ `9b3101b5a9a60ec46e5c04647948c03665b705e8`.

**Smoke-маршруты для ручной/скриптовой проверки после любых изменений:** `GET /`, `GET /health`, `GET /terraintel/`.

---

## 13. SAFETY / SECURITY

- **Секреты только в environment variables**, никогда не коммитятся в репозиторий (`.env.example` содержит только шаблон/плейсхолдеры).
- `POLZA_API_KEY`, ключи S3, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN` — используются **только на сервере**, в браузер никогда не передаются.
- **Rate limits** на всех внешних/дорогих роутах: `/api/contact` (5/15мин), `/api/ai` (30/15мин), `/api/certificates/login` (10/15мин), `/api/terraintel/analyze` (свой лимит на IP + общий дневной бюджет).
- **Honeypot** и дедупликация по фингерпринту на контактной форме.
- **Чистка входных данных**: управляющие символы вырезаются, длина полей жёстко ограничена во всех роутерах (`cleanText`/`cleanSingleLineText`/`cleanMultilineText`).
- **Доступ к S3**: только с сервера, через `@aws-sdk/client-s3`, credentials из env; публичные GET-роуты не требуют авторизации (это ожидаемо — сертификаты/проекты публичны), но все мутации требуют валидной owner-сессии.
- **Admin-аутентификация**: `?admin=1` в URL — это **исключительно фронтенд-флаг видимости UI**, независимо пересчитываемый в Projects/Certificates/Skills; он никогда не читается и не проверяется backend-ом (подтверждено грепом по `server.js`/`lib/*.js` — нет ни одного `req.query.admin`). Реальная защита — подписанная HMAC-сессия (`requireOwnerSession`), проверяется на каждом мутирующем запросе отдельно от UI-флага. **Путать `?admin=1` с реальной авторизацией — грубая ошибка**, которую стоит явно избегать в будущих задачах.
- **TerraIntel forbidden claims**: отдельный серверный regex-фильтр (`FORBIDDEN_CLAIMS` в `lib/terraintel.js`) обрезает любые утверждения модели о найденных минах/оружии/боеприпасах или о «безопасной территории», независимо от системного промпта — это второй, независимый уровень защиты, не полагающийся только на поведение модели.
- **LLM JSON normalization**: оба AI-роута (`/api/ai` неявно через прямой парсинг, `/api/terraintel/analyze` явно через `extractJson`/`normalizeInterpretations`) устойчивы к обёртке ответа модели в \`\`\`json-фенсы и к посторонним id в ответе — маппинг строго по известным id запроса, лишнее отбрасывается.
- **Риск регрессии в общем приложении**: поскольку всё крутится в одном Express-процессе и один файл `public/index.html` держит почти весь портфолио, случайная правка общего CSS/JS-блока может задеть несколько разделов разом (Projects/Skills/Certificates используют похожие паттерны кода). Изменения в `public/index.html` стоит тестировать по всем разделам, а не только по тому, который менялся.

---

## 14. CRITICAL PROTECTED AREAS — НЕ ЛОМАТЬ БЕЗ НЕОБХОДИМОСТИ

**Portfolio:**
- `public/index.html` — весь главный сайт в одном файле; любое изменение проверять по всем разделам (Home/About/Projects/Skills/Certificates/Contacts/AI/Legal) и на мобильной+десктопной ширине.
- `/` — маршрут SPA fallback.
- `/api/ai` — AI-ассистент портфолио.
- `/api/contact` — контактная форма, обязательный Telegram-канал.

**TerraIntel (не трогать без явного запроса на работу именно с TerraIntel):**
- `public/terraintel/**` (включая `vendor/` — локальная копия MapLibre GL JS)
- `lib/terraintel.js`
- `test/terraintel.test.js`
- `/terraintel/`
- `/api/terraintel/analyze`

**Certificates:**
- `lib/certificates.js` — также содержит общие примитивы (`createS3Client`, `requireSameOrigin`, `requireOwnerSession`, `verifySession`, `parseCookies`), которые переиспользует `lib/projects.js` — менять с осторожностью, поломка здесь задевает оба модуля.
- `/api/certificates/*`

**Projects:**
- `lib/projects.js`
- `/api/projects/*`
- переиспользуемая owner-сессия (cookie `cert_admin`, `Path=/api`) — общая с Certificates, менять контракт cookie нельзя без синхронной правки обоих модулей.

**Общая инфраструктура:**
- `server.js` — порядок монтирования роутеров важен (`/api/terraintel`, `/api/certificates`, `/api/projects` должны стоять **до** SPA-fallback `app.get('*', ...)`).
- `.env.example` / реальные production-переменные окружения — не удалять и не переименовывать существующие имена переменных без согласования, это сломает production-конфигурацию.

---

## 15. DEVELOPMENT WORKFLOW

1. `git fetch origin main`
2. `git checkout main` → `git pull origin main` — получить актуальный `main`, не полагаться на этот снимок как на текущее состояние.
3. Создать новую ветку `feature/...` или `fix/...` от актуального `main` под конкретную задачу.
4. Делать минимальный diff под задачу — не трогать несвязанные модули.
5. `npm test` — убедиться, что базовая линия тестов (на момент снимка — 94/94) не сломана.
6. Smoke-проверка `GET /`.
7. Smoke-проверка `GET /health`.
8. Smoke-проверка `GET /terraintel/` (даже если задача не про TerraIntel — убедиться, что общий процесс/монтирование роутов не сломано).
9. `git diff`/`git status` — внимательно проверить итоговый набор изменённых файлов перед коммитом.
10. Commit с понятным сообщением.
11. `git push -u origin <branch>`.
12. Открыть Pull Request с описанием, что и почему изменено.
13. **Не мержить PR без явного подтверждения пользователя** — ни при каких обстоятельствах, даже если все проверки зелёные.
14. После подтверждённого мержа — деплой на Timeweb (из `main`), затем production smoke-проверка (`/`, `/health`, при необходимости — конкретный изменённый функционал) по возможности силами пользователя, если у агента нет сетевого доступа к `*.twc1.net`.

**Запрещено:**
- Прямые изменения в `main` в обход Pull Request.
- Скрытые архитектурные изменения, не относящиеся к заявленной задаче (например, тихая правка общего S3-клиента ради несвязанной фичи).
- Автомерж без подтверждения — даже «только документация» или «только README» мержится по явному запросу пользователя.
- Вмешательство в модули, не относящиеся к задаче (особенно TerraIntel, если задача не про него).

---

## 16. KNOWN TECH DEBT

| ISSUE | CURRENT IMPACT | FUTURE FIX |
|---|---|---|
| Общий монолитный деплой (один Express-процесс на весь сайт + TerraIntel + все API) | Любой краш/утечка памяти в одном модуле может затронуть весь сайт; нет изоляции нагрузки между Portfolio AI и TerraIntel AI | Вынести TerraIntel и/или API в отдельные процессы/сервисы, если нагрузка это оправдает — не критично при текущем масштабе |
| `README.md` устарел: описывает Projects и Certificates как Supabase-based, хотя оба уже на Timeweb S3 | Вводит в заблуждение нового разработчика/агента, который читает только README | Обновить README (этот handoff уже добавлен туда ссылкой — см. раздел 19.1 процесса) |
| TerraIntel landing — 2.6 МБ base64-картинка вшита прямо в HTML вместо отдельного WebP-файла | Каждая загрузка `/terraintel/` тянет многократно раздутый HTML | Вынести в `public/terraintel/assets/*.webp`, подключить как обычный `background-image:url(...)` |
| TerraIntel UI обещает 5 сенсоров и многопроектность, реализована только магнитометрия+GPS в одном localStorage-слоте | Риск завышенных ожиданий у пользователей/комиссии при демонстрации | Либо явно пометить нереализованные части как roadmap в самом UI, либо спроектировать реальную многопроектность с backend-хранилищем |
| In-memory лимиты (контактная дедупликация, TerraIntel daily budget, rate-limit счётчики) живут только в памяти процесса | Сбрасываются при каждом рестарте/редеплое; не масштабируются на несколько инстансов | Приемлемо при одном инстансе Timeweb App Platform; вынести в Redis/БД только если появится горизонтальное масштабирование |
| Нет персистентности проекта TerraIntel на сервере (только `localStorage` браузера) | Пользователь теряет результаты анализа при смене браузера/устройства или очистке данных | Спроектировать серверное хранилище проектов TerraIntel, если платформа будет развиваться за пределы учебного MVP |
| Внешние AI-зависимости (Polza AI для обоих ассистентов) — единая точка отказа | Если Polza недоступна — AI-функции обоих разделов деградируют одновременно (у TerraIntel есть достойный fallback, у Portfolio AI — явная ошибка пользователю) | Не критично для MVP; при необходимости — fallback-провайдер |
| Доступность Telegram (`api.telegram.org`) — единственный обязательный канал контактной формы | Если Telegram API недоступен — форма целиком недоступна (эндпоинт отдаёт 502/503), email — не подстрахует, т.к. он опционален и идёт только после успешного Telegram | Осознанный компромисс по требованию задачи (Telegram как основной обязательный канал) — фиксировать как факт, не как баг |
| Зависимость карты TerraIntel от MapTiler (внешний провайдер тайлов, ключ зашит в клиентском JS) | Недоступность MapTiler/блокировка домена ломает страницу «Карта» целиком | Домен-рестрикция ключа в кабинете MapTiler снижает риск злоупотребления ключом, но не снимает зависимость от провайдера |
| Observability: нет структурированного логирования/метрик/трейсинга, только `console.log`/`console.error` | Расследование инцидентов на проде затруднено без доступа к логам Timeweb | Не критично для текущего масштаба; рассмотреть при росте нагрузки |
| `public/index.html` (~3550 строк) и `public/terraintel/index.html` — однофайловые фронтенды без сборки | Любая правка требует аккуратного ручного поиска нужного блока в большом файле; риск случайно задеть несвязанный раздел | Осознанный архитектурный выбор для простоты деплоя (никакого build step); не трогать без явного запроса на рефакторинг |
| `PROJECTS_MAX_FILE_SIZE_MB` используется в коде, но отсутствует в `.env.example` | Новый разработчик может не узнать об этой переменной, не прочитав `lib/projects.js` | Добавить строку в `.env.example` при следующей правке env-документации |

---

## 17. ROADMAP

Ниже — только предложения на основе текущего состояния кода, не подтверждённые пользователем задачи. Не предполагать, что что-либо из этого уже одобрено к разработке.

**P0 (сделать в первую очередь, если задача появится):**
- Обновить `README.md`, убрав устаревшие упоминания Supabase для Projects/Certificates (чисто документационная правка, низкий риск).
- Задокументировать `PROJECTS_MAX_FILE_SIZE_MB` в `.env.example`.

**P1:**
- Вынести 2.6 МБ base64-изображение TerraIntel landing в отдельный WebP-файл — измеримый выигрыш в производительности загрузки при низком риске.
- Явно пометить на лендинге TerraIntel, какие сенсоры (LiDAR/тепловизор/RGB) — реализованы, а какие — roadmap, чтобы не создавать ложных ожиданий.
- Добавить предупреждение в TerraIntel при перезаписи единственного сохранённого проекта в `localStorage`.

**P2:**
- Тесты для фронтенд-логики TerraIntel (`terraDetect`, парсер CSV, расчёт синхронизации) — сейчас этот код полностью непротестирован.
- Чистка мёртвого/дублирующегося CSS в `public/terraintel/index.html` (несколько поколений мокапов дашборда в одном файле).
- Рассмотреть реальную многопроектность TerraIntel (серверное хранилище) — только если платформа будет развиваться за пределы учебного MVP, это архитектурно значимое изменение, не делать без отдельного обсуждения с пользователем.

---

## 18. START HERE FOR A NEW AI AGENT

Если этот документ читает новый ИИ-агент без доступа к истории разговора — вот самое важное за 30 пунктов:

1. Repository: `Supaplex777/evgeny-portfolio-timeweb`, рабочая ветка — `main`.
2. На момент этого снимка `main` был на SHA `9b3101b5a9a60ec46e5c04647948c03665b705e8`, 94/94 теста зелёные — но это снимок, не текущее состояние, см. пункт 30.
3. Это один монолитный Express-процесс (`server.js`), не микросервисы.
4. Главный сайт («Portfolio») — почти целиком один файл `public/index.html` (~3550 строк), роутинг разделов через CSS `:target`, без build step.
5. Модули проекта: Portfolio, TerraIntel, Certificates, Projects, Contact/Telegram, Portfolio AI, Skills (frontend-only).
6. **TerraIntel полностью независим**: свой фронтенд (`public/terraintel/**`), свой backend (`lib/terraintel.js`), своя AI-модель (`sber/gigachat-2`), свои лимиты, свой роут `/api/terraintel/analyze`. Не трогать без явной задачи именно про TerraIntel.
7. TerraIntel реально умеет только магнитометрия+GPS/ГЛОНАСС; LiDAR/тепловизор/RGB/многопроектность — это только визуальный макет, не функциональность.
8. TerraIntel хранит единственный проект только в `localStorage` браузера, backend ничего не хранит.
9. TerraIntel AI safety: двухуровневая защита — системный промпт + серверный regex-фильтр `FORBIDDEN_CLAIMS`, модель никогда не должна «обнаруживать мины» или «объявлять территорию безопасной».
10. Certificates (`lib/certificates.js`, `/api/certificates/*`) хранятся на **Timeweb Cloud S3**, Supabase здесь больше не используется.
11. Projects (`lib/projects.js`, `/api/projects/*`) хранятся в **том же самом** бакете S3, что и Certificates, под префиксом `projects/`. **Supabase для Projects тоже больше не используется** — если видите задачу «мигрировать Projects с Supabase», сначала проверьте код, она уже выполнена.
12. Certificates и Projects используют одну общую owner-сессию (cookie `cert_admin`, `Path=/api`), логин — `POST /api/certificates/login`.
13. `?admin=1` в URL — это **только фронтенд UI-флаг видимости**, backend его вообще не читает. Реальная защита мутирующих роутов — `requireOwnerSession` (подписанная HMAC-cookie), проверяемая отдельно сервером.
14. Contact form (`POST /api/contact`) — **Telegram обязателен** (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`), без него роут отдаёт 500. Email через Resend — опциональный best-effort второй канал.
15. Portfolio AI (`POST /api/ai`) и TerraIntel AI (`POST /api/terraintel/analyze`) — это два полностью независимых AI-пути, разные модели, разные промпты, не путать.
16. Skills — единственный раздел вообще без backend, только `localStorage` браузера посетителя, нет роута `/api/skills`.
17. Все секреты — только в environment variables, никогда не в репозитории.
18. Тесты: `npm test` (node:test, без сети и реальных ключей), все внешние вызовы подменены заглушками.
19. Перед любой работой — запускать `npm test`, сверяться с актуальным количеством тестов (на снимке — 94).
20. Smoke-маршруты после изменений: `GET /`, `GET /health`, `GET /terraintel/`.
21. Production — Timeweb Cloud App Platform, деплой из `main`, health-check `/health`. Из типичной песочницы агента `*.twc1.net` обычно недоступен по сети — не выдавать предположения о проде за проверенный факт.
22. **Никогда не мержить PR без явного подтверждения пользователя**, даже если всё зелёное.
23. Никогда не удалять существующие feature/fix-ветки без явного запроса.
24. Не трогать `server.js` без необходимости; если пришлось — порядок монтирования роутеров (`terraintel` → `certificates` → `projects` → SPA fallback) критичен и должен сохраняться.
25. Не вносить скрытых архитектурных изменений, не относящихся к заявленной задаче.
26. `README.md` частично устарел (всё ещё упоминает Supabase для Projects/Certificates) — не доверять ему слепо, этот handoff и реальный код приоритетнее.
27. Известный техдолг и приоритеты доработки — см. разделы 16–17 этого документа; ничего из роадмапа не считается одобренным, пока пользователь явно не попросит.
28. Любое сомнительное или непроверенное утверждение в разговоре с пользователем помечать как `[UNKNOWN]` или `[PLAN]`, а не выдавать за факт.
29. Если задача про мобильную адаптацию/верстку — проверять и десктопную, и мобильную ширину, не только одну из них.
30. Этот документ описывает состояние на конкретный SHA и дату (раздел 1) — он устареет по мере новых PR. Не экономить на перепроверке.

Перед любой новой задачей сначала выполнить `git fetch`, проверить актуальный `main` и не предполагать, что состояние репозитория осталось таким же, как в этом handoff.
