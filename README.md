# Backroom

An anonymous confession board. People pin short notes to a shared wall, react to each other's stories, reply in threads, and hang out in topic rooms. No accounts, no emails, no sign-up.

The interface looks like paper notes on a wall instead of a feed: handwritten text, tilted sticky notes, and a calm palette that follows your system's light or dark mode.

## Features

- **Anonymous posting.** Notes up to 280 characters. Every note gets a random name such as "Quiet Heron".
- **Reactions.** *me too*, *hug*, *ouch* and *haha*. Tap once to add, tap again to take it back.
- **Threaded replies.** Up to 140 characters. The original poster keeps their note's name in the thread, and everyone else gets one stable name per thread.
- **Six topic rooms.** Late nights, Work & money, Crushes, Family, Small wins, Campus. Join the ones you like and filter to "My rooms only".
- **Sorting.** Newest, or most felt.
- **Basic moderation.** Three reports from three different devices hide a note. All write routes are rate limited.

## How anonymity works

- There are no accounts. Your browser creates a random token on first visit and keeps it in `localStorage`.
- The server stores only a salted SHA-256 hash of that token, never the token itself and never your IP address.
- The hash is used for three things: knowing which notes are yours, stopping duplicate reactions and reports, and giving you a stable name in a thread.
- Clearing your browser data creates a new identity, so you lose "my notes". That is by design.

This is pseudonymous, not magic. Anyone with access to your database and your `SALT` could still link activity from one device together, so keep both private.

## Tech stack

| Part | Choice |
| --- | --- |
| Server | Node.js 18+, Express 4 |
| Database | PostgreSQL (tested design for Neon's free tier) |
| Frontend | One static HTML file, no build step, no framework |
| Hosting | Render (web service) + Neon (database) |

## Project structure

```
backroom/
├── server.js          API, schema setup and static file serving
├── public/
│   └── index.html     the whole frontend (HTML, CSS, JS)
├── render.yaml        Render blueprint
├── .env.example       environment variable template
├── package.json
├── LICENSE
└── README.md
```

## Run it locally

You need Node.js 18 or newer and a Postgres connection string. The easiest free database is [Neon](https://neon.com).

```bash
git clone https://github.com/YOUR-USERNAME/backroom.git
cd backroom
npm install
```

Create a `.env` file from the template and fill it in:

```bash
# macOS / Linux
cp .env.example .env

# Windows (Command Prompt)
copy .env.example .env
```

Then edit `.env`:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require
SALT=a-long-random-string
```

Start it:

```bash
npm start
```

Open http://localhost:3000. On the first start the tables are created automatically, and a few starter notes are added if the database is empty.

## Get a free database (Neon)

1. Sign up at neon.com (no card needed) and create a project.
2. Click **Connect** and copy the connection string.
3. Paste it into `.env` as `DATABASE_URL`.

Use Neon rather than Render's own free Postgres: Render's free database is deleted 30 days after creation, while Neon's free tier does not expire.

## Deploy on Render

1. Push this repository to GitHub.
2. On Render choose **New → Web Service** and connect the repository. (Or choose **New → Blueprint** to use `render.yaml`.)
3. Settings: runtime **Node**, build command `npm install`, start command `node server.js`, plan **Free**.
4. Add environment variables:
   - `DATABASE_URL`: your Neon connection string
   - `SALT`: a long random string (the blueprint can generate one for you)
5. Deploy. Render gives you a public `onrender.com` address.

**Do not change `SALT` after launch.** It would break "my notes", reaction tracking and thread names for existing users.

Free Render services sleep after about 15 minutes without traffic, so the first visit after a quiet spell takes a few seconds. The page shows a "waking up" message while that happens.

## API

All routes live under `/api` and need an `x-device` header containing the browser's random token (the frontend sends it automatically).

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/rooms` | Note count per room |
| GET | `/api/posts?room=&sort=` | Up to 100 notes. `sort` is `new` or `top`; `room` is optional |
| POST | `/api/posts` | Create a note: `{ "room": "late", "text": "..." }` |
| POST | `/api/posts/:id/react` | Toggle a reaction: `{ "kind": "me" }` (`me`, `hug`, `ouch`, `haha`) |
| GET | `/api/posts/:id/replies` | Replies for a note |
| POST | `/api/posts/:id/replies` | Add a reply: `{ "text": "..." }` |
| POST | `/api/posts/:id/report` | Report a note |
| GET | `/healthz` | Health check |

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `SALT` | yes in production | Secret used when hashing device tokens |
| `PORT` | no | Defaults to 3000 (Render sets this itself) |
| `PGSSL` | no | Set to `off` to disable SSL for a local Postgres |

## Troubleshooting

- **`getaddrinfo ENOTFOUND base`**: `DATABASE_URL` still holds a placeholder. Use your real connection string.
- **`getaddrinfo ENOTFOUND ...neon.tech`**: your network could not resolve the database host. Copy the string again from Neon's **Connect** button, check the project still exists, and try another network or DNS (for example 1.1.1.1).
- **Password authentication failed**: the user or password in the connection string is wrong. Reset the password in Neon and copy a fresh string.
- **SSL mode warning on start**: harmless. It is a notice from the `pg` driver about a future version.
- **Windows Command Prompt**: if you set variables by hand instead of using `.env`, use `set "DATABASE_URL=..."`. The `VAR=value npm start` form only works on macOS and Linux.

## Ideas for next steps

- Admin view for reviewing hidden notes
- Pagination ("load older notes") past the first 100
- Auto-refresh while the page is open
- Per-room rules and room descriptions

## Security notes

- Never commit `.env`. It is already listed in `.gitignore`.
- Rotate your database password if it ever appears in a screenshot, log or chat.
- The word filter is minimal. Before a public launch, add stronger moderation and a way to remove notes quickly.

## License

MIT. See [LICENSE](LICENSE).
