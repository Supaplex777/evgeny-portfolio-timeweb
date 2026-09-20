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
│   └── assets/
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
```

`RESEND_API_KEY` и `CONTACT_EMAIL_FROM` нужны только для автоматической отправки заявок на email. Адрес отправителя должен быть подтверждён в Resend. Никогда не добавляйте `.env` или реальные ключи в GitHub.

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
