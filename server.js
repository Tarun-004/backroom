try { require('dotenv').config(); } catch (e) {} // optional: loads .env for local runs
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 5,
});
const SALT = process.env.SALT || 'dev-salt-change-me';
const ROOMS = ['late', 'work', 'crush', 'fam', 'wins', 'camp'];
const KINDS = ['me', 'hug', 'ouch', 'haha'];
const A1 = ['Quiet','Sleepy','Borrowed','Paper','Midnight','Soft','Rusty','Lost','Tiny','Wandering'];
const A2 = ['Heron','Teapot','Moth','Lantern','Pigeon','Biscuit','Comet','Otter','Kettle','Fern'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const aliasFrom = (hex) =>
  A1[parseInt(hex.slice(0, 4), 16) % A1.length] + ' ' + A2[parseInt(hex.slice(4, 8), 16) % A2.length];
const randomAlias = () => aliasFrom(crypto.randomBytes(4).toString('hex'));

// Anonymous identity: the browser keeps a random token; we only ever store a salted hash of it.
function device(req, res, next) {
  const t = req.get('x-device') || '';
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(t)) return res.status(400).json({ error: 'Missing device id' });
  req.dev = sha(SALT + t);
  next();
}
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const clean = (s, max) => String(s || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

const writeLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Slow down a little and try again in a few minutes.' } });
const readLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });

const api = express.Router();
api.use(readLimit, device);

api.get('/rooms', wrap(async (req, res) => {
  const { rows } = await pool.query('select room, count(*)::int n from posts where not hidden group by room');
  const counts = {};
  rows.forEach((r) => (counts[r.room] = r.n));
  res.json({ counts });
}));

api.get('/posts', wrap(async (req, res) => {
  const room = ROOMS.includes(req.query.room) ? req.query.room : null;
  const order = req.query.sort === 'top'
    ? '(select count(*) from reactions where post_id = p.id) desc, p.created_at desc'
    : 'p.created_at desc';
  const { rows } = await pool.query(
    `select p.id::text, p.room, p.body, p.alias, p.created_at, (p.author = $1) as own,
       coalesce((select json_object_agg(kind, n) from
         (select kind, count(*)::int n from reactions where post_id = p.id group by kind) x), '{}'::json) as r,
       coalesce((select json_agg(kind) from reactions where post_id = p.id and device = $1), '[]'::json) as felt,
       (select count(*) from replies where post_id = p.id)::int as rc
     from posts p
     where not p.hidden and ($2::text is null or p.room = $2)
     order by ${order} limit 100`, [req.dev, room]);
  res.json({ posts: rows });
}));

api.post('/posts', writeLimit, wrap(async (req, res) => {
  const room = req.body.room, body = clean(req.body.text, 280);
  if (!ROOMS.includes(room)) return res.status(400).json({ error: 'Pick a room first.' });
  if (body.length < 3) return res.status(400).json({ error: 'Write a little more.' });
  const { rows } = await pool.query(
    `insert into posts(room, body, alias, author) values($1,$2,$3,$4)
     returning id::text, room, body, alias, created_at, true as own, '{}'::json as r, '[]'::json as felt, 0 as rc`,
    [room, body, randomAlias(), req.dev]);
  res.status(201).json(rows[0]);
}));

api.post('/posts/:id/react', writeLimit, wrap(async (req, res) => {
  const { id } = req.params, kind = req.body.kind;
  if (!/^\d+$/.test(id) || !KINDS.includes(kind)) return res.status(400).json({ error: 'Bad request' });
  const del = await pool.query('delete from reactions where post_id=$1 and device=$2 and kind=$3', [id, req.dev, kind]);
  if (!del.rowCount) {
    try { await pool.query('insert into reactions(post_id, device, kind) values($1,$2,$3)', [id, req.dev, kind]); }
    catch (e) { if (e.code === '23503') return res.status(404).json({ error: 'That note is gone.' }); throw e; }
  }
  res.json({ on: !del.rowCount });
}));

api.get('/posts/:id/replies', wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad request' });
  const { rows } = await pool.query(
    'select alias, body, created_at, (author=$2) as own from replies where post_id=$1 order by created_at', [req.params.id, req.dev]);
  res.json({ replies: rows });
}));

api.post('/posts/:id/replies', writeLimit, wrap(async (req, res) => {
  const { id } = req.params, body = clean(req.body.text, 140);
  if (!/^\d+$/.test(id) || !body) return res.status(400).json({ error: 'Write a reply first.' });
  const post = await pool.query('select author, alias from posts where id=$1 and not hidden', [id]);
  if (!post.rowCount) return res.status(404).json({ error: 'That note is gone.' });
  // The original poster keeps their note's name in the thread; everyone else gets a stable name per thread.
  const alias = post.rows[0].author === req.dev ? post.rows[0].alias : aliasFrom(sha(req.dev + id));
  const { rows } = await pool.query(
    'insert into replies(post_id, body, alias, author) values($1,$2,$3,$4) returning alias, body, created_at, true as own',
    [id, body, alias, req.dev]);
  res.status(201).json(rows[0]);
}));

api.post('/posts/:id/report', writeLimit, wrap(async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Bad request' });
  let hidden = false;
  try {
    const ins = await pool.query('insert into reports(post_id, device) values($1,$2) on conflict do nothing', [id, req.dev]);
    if (ins.rowCount) {
      const up = await pool.query('update posts set reports = reports + 1, hidden = (reports + 1 >= 3) where id=$1 returning hidden', [id]);
      hidden = !!(up.rows[0] && up.rows[0].hidden);
    }
  } catch (e) { if (e.code !== '23503') throw e; }
  res.json({ ok: true, hidden });
}));

app.use('/api', api);
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something broke on our side.' });
});

const SCHEMA = `
create table if not exists posts(
  id bigserial primary key, room text not null, body text not null, alias text not null, author text not null,
  created_at timestamptz not null default now(), reports int not null default 0, hidden boolean not null default false);
create index if not exists posts_room_created on posts(room, created_at desc);
create table if not exists reactions(
  post_id bigint references posts(id) on delete cascade, device text, kind text, primary key(post_id, device, kind));
create table if not exists replies(
  id bigserial primary key, post_id bigint references posts(id) on delete cascade, body text not null,
  alias text not null, author text not null, created_at timestamptz not null default now());
create index if not exists replies_post on replies(post_id, created_at);
create table if not exists reports(
  post_id bigint references posts(id) on delete cascade, device text, primary key(post_id, device));`;

const SEED = [
  ['late', 'Quiet Heron', 'I still keep the voicemail from my grandmother. I play it when the house is quiet.', 1],
  ['work', 'Rusty Kettle', 'I have been "in a meeting" for two hours. I am watching videos of people restoring old knives.', 3],
  ['crush', 'Tiny Comet', 'Told her I liked her playlist. I made the playlist. I made it for her. She has no idea.', 5],
  ['wins', 'Sleepy Fern', 'Made my bed, ate a real breakfast, and answered the email I’d been avoiding for nine days.', 8],
  ['camp', 'Paper Pigeon', 'I’ve been eating lunch in the library stairwell for a month so nobody notices I’m alone.', 26],
];

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
  await pool.query(SCHEMA);
  const { rows } = await pool.query('select count(*)::int n from posts');
  if (!rows[0].n) {
    for (const [room, alias, body, h] of SEED)
      await pool.query(`insert into posts(room, body, alias, author, created_at) values($1,$2,$3,'seed', now() - ($4 || ' hours')::interval)`, [room, body, alias, String(h)]);
  }
  app.listen(process.env.PORT || 3000, () => console.log('Backroom is up'));
})().catch((e) => { console.error(e); process.exit(1); });
