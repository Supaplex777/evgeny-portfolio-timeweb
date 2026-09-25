# Evgeny Portfolio — AI Automation Specialist

Интерактивное профессиональное портфолио Евгения Смирнова: AI-ассистент, проекты и сертификаты из Supabase, контактная форма и production-развёртывание на Timeweb Cloud App Platform.

## Live Demo

[Открыть сайт](https://supaplex777-evgeny-portfolio-timeweb-1140.twc1.net/)

## Возможности

- AI-панель «AI о Евгении» на Polza AI (`openai/gpt-oss-20b`)
- интерактивный раздел «Обо мне»
- проекты и изображения проектов из Supabase
- управление проектами для авторизованного владельца
- сертификаты из Supabase Storage
- контактная форма: сохранение заявок и серверная доставка email
- responsive-интерфейс для мобильных устройств, ноутбуков и широких экранов
- WebP-оптимизация визуальных материалов

## Stack

- HTML, CSS, JavaScript
- Node.js, Express
- Supabase Database, Storage и RLS
- Polza AI, `openai/gpt-oss-20b`
- Timeweb Cloud App Platform

## Архитектура

- **Frontend:** `public/index.html`, CSS/JS и WebP-ассеты.
- **Backend:** Express, `/api/ai`, `/api/contact`, `/health`.
- **Data:** Supabase Database, Storage и RLS-политики.
- **Email:** Resend API вызывается только сервером, если настроены environment variables.

## Безопасность

- Секреты хранятся только в environment variables, не в GitHub.
- `service_role` не используется во frontend.
- Доступ Supabase ограничен RLS; публичные заявки не читаются из браузера.
- `/api/ai` и `/api/contact` защищены rate limit; форма содержит honeypot и защиту от повторной отправки.
- GitHub Secret Scanning: **No secrets found**.

## Project structure

```text
evgeny-portfolio-timeweb/
├── public/
│   ├── index.html
│   ├── assets/
│   └── terraintel/          # TerraIntel MVP (/terraintel/)
│       ├── index.html
│       └── vendor/          # MapLibre GL JS 5.7.1 (локальная копия, BSD-3)
├── lib/
│   └── terraintel.js        # AI backend TerraIntel: POST /api/terraintel/analyze
├── test/
│   └── terraintel.test.js
├── server.js
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
└── README.md
```

## Local run

```bash
npm ci
npm start
npm test   # тесты TerraIntel API (Polza подменяется заглушкой, сеть и ключ не нужны)
```

Приложение будет доступно на `http://localhost:3000`.

## Environment variables

```text
POLZA_API_KEY
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
CONTACT_EMAIL_TO
RESEND_API_KEY
CONTACT_EMAIL_FROM
PORT

# TerraIntel (все необязательные)
TERRAINTEL_MODEL        # по умолчанию sber/gigachat-2
TERRAINTEL_RATE_LIMIT   # запросов с одного IP за 15 минут, по умолчанию 10
TERRAINTEL_DAILY_LIMIT  # общий дневной лимит AI-запросов TerraIntel, по умолчанию 200
TERRAINTEL_TIMEOUT_MS   # таймаут запроса к Polza, по умолчанию 30000
```

`RESEND_API_KEY` и `CONTACT_EMAIL_FROM` нужны только для автоматической отправки заявок на email. Адрес отправителя должен быть подтверждён в Resend. Никогда не добавляйте `.env` или реальные ключи в GitHub.

## TerraIntel MVP

Учебный MVP анализа магнитометрии + GPS/ГЛОНАСС, работает на том же Express-сервере как отдельный интерфейс:

| Путь | Назначение |
|---|---|
| `/terraintel/` | интерфейс TerraIntel (`public/terraintel/index.html`) |
| `POST /api/terraintel/analyze` | AI-интерпретация аномалий (Polza AI, `sber/gigachat-2`) |

- CSV обрабатываются только в браузере: парсинг → Robust Z (медиана/MAD) → до 20 кандидатов аномалий → геопривязка.
- На сервер уходят только подготовленные аномалии (`id`, `lat`, `lon`, `robust_z`, `sample_index`, `timestamp`); сервер отбрасывает любые другие поля.
- Запрос same-origin: Cloudflare Worker и CORS не используются. `POLZA_API_KEY` — только на сервере.
- Отдельный системный промпт: AI не определяет тип объекта, не заявляет о минах/оружии, не объявляет территорию безопасной; итог требует экспертной проверки.
- Если AI недоступен, найденные аномалии сохраняются с локальным объяснением, пользователь видит причину.
- Защита расходов: отдельный rate limit по IP, общий дневной лимит, таймаут, лимит 20 аномалий и 64 КБ на запрос.
- Качество синхронизации — доля точек магнитометра с GPS-фиксацией в пределах 2 медианных интервалов GPS; без временных меток выводится «не рассчитано».
- «PDF» — печать через браузер (`window.print`), отдельного PDF-генератора нет.
- MapTiler key используется в браузере: в кабинете MapTiler должны быть заданы разрешённые домены.

## Production

- Branch: `main`
- Hosting: Timeweb Cloud App Platform
- Start command: `npm start`
- Health check: `/health`

## Author

Евгений Смирнов — AI Automation Specialist

- GitHub: [Supaplex777](https://github.com/Supaplex777)
- Telegram: [@SupaplexEVG](https://t.me/SupaplexEVG)
- Email: [cmrrus@rambler.ru](mailto:cmrrus@rambler.ru)
- Kwork: [supaplexevg](https://kwork.ru/user/supaplexevg)
