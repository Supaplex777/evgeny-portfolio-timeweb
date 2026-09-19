# Evgeny Portfolio — Timeweb

Личное профессиональное портфолио с HTML/CSS/JavaScript-интерфейсом,
Express-сервером, данными сертификатов из Supabase и серверным прокси к Polza AI.

## Stack

- Node.js
- Express
- HTML/CSS/JavaScript
- Supabase
- Polza AI
- GPT-OSS-20B

## Project structure

```text
evgeny-portfolio-timeweb/
├── public/
│   └── index.html
├── server.js
├── package.json
├── .gitignore
├── .env.example
└── README.md
```

## Environment variables

- `POLZA_API_KEY` — обязательная секретная переменная для запросов к Polza AI.
- `SUPABASE_URL` — URL проекта Supabase; при необходимости переопределяет значение по умолчанию.
- `SUPABASE_PUBLISHABLE_KEY` — публичный клиентский ключ Supabase; при необходимости переопределяет значение по умолчанию. Доступ к данным должен быть защищен Row Level Security (RLS).

Never commit `.env` or API secrets to GitHub.

Скопируйте `.env.example` в `.env` и заполните значения только в локальном окружении или в настройках платформы.

## Local run

```bash
npm install
npm start
```

По умолчанию приложение доступно на `http://localhost:3000`. На хостинге сервер использует порт из переменной `PORT`.

## Deployment

Проект предназначен для Timeweb App Platform. Используйте Node.js 20 или новее и команду запуска `npm start`.
