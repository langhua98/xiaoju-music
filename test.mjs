// 本地测试：Node 自带的 SQLite 模拟 Durable Object，再模拟 Telegram 和流式服务，逐条验证 worker.js
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

register('./test/hooks.mjs', import.meta.url);
const { default: worker, Library } = await import('./worker.js');

const TOKEN = '123:SECRET-BOT-TOKEN';
const HOOK = 'hook-secret';
const ADMIN = 'admin-key-123';
const SKEY = 'streamer-key-456';
const STREAMER = 'https://streamer.example';
const CHANNEL = -1003817921075;
const MB = 1024 * 1024;
const LIMIT = 20 * MB;

// ── 模拟 Durable Object（SQLite + 结构化克隆，和 RPC 一样不共享引用）──
const sqlLog = [];  // 跑过的查询（检查「读一次就记在内存里」用）
function makeSql(db = new DatabaseSync(':memory:')) {
  return { exec: (query, ...params) => {
    sqlLog.push(query);
    const st = db.prepare(query);
    if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query) && !/\bRETURNING\b/i.test(query)) {  // 写入：和 Cloudflare 一样给 rowsWritten
      const info = st.run(...params);
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    }
    const rows = st.all(...params).map(r => ({ ...r }));
    return { toArray: () => rows, rowsWritten: 0 };
  } };
}
async function makeLibrary(env, db = new DatabaseSync(':memory:')) {
  let ready;
  const ctx = { storage: { sql: makeSql(db) }, blockConcurrencyWhile(fn) { ready = fn(); return ready; } };
  const lib = new Library(ctx, env);
  await ready;
  return new Proxy({}, {
    get: (_, name) => name === 'then' ? undefined : name === '_db' ? db : async (...args) => structuredClone(await lib[name](...structuredClone(args))),
  });
}
// 更早版本的 KV：每页只给 1 条，逼出分页
function makeKV(records) {
  const m = new Map(records.map(r => ['t:' + r.id, JSON.stringify(r)]));
  return {
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async list({ prefix, cursor }) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const done = start + 1 >= keys.length;
      return { keys: keys.slice(start, start + 1).map(name => ({ name })), list_complete: done, cursor: done ? '' : String(start + 1) };
    },
  };
}

// ── 模拟 Telegram（小文件）和流式服务（大文件）──
const files = new Map();   // file_id -> 字节（Bot API 能取的小文件）
const bigFiles = new Map(); // 消息号 -> 字节（只有流式服务取得到）
const thumbs = new Map();   // 消息号 -> 封面字节（流式服务用 MTProto 取的那种）
const oldPhotos = new Map(); // 更早的图片帖：消息号 -> 字节（只有流式服务取得到）
let seq = 0;
const addFile = bytes => { const id = 'F' + (++seq); files.set(id, bytes); return id; };
const bytesOf = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed + (i >> 12)) & 255; return b; };
const calls = [];
const OWNER = 777, FAN = 555;
const bot = { out: [], toStreamer: [], search: [], pickId: 0, autoStatus: { status: 'idle' }, adminAsks: 0, copyBusy: false, streamerDown: false, copyFail: '', review: null, sheet: null };
const mode = { getFile: 'ok', expireOnce: false, streamer: 'ok', thumbs: 'ok', lrclib: 'ok', netease: 'ok', viz: 'ok' };
// 模拟歌词来源：LRCLIB 的歌词库，网易云的歌和歌词
const lrclibDb = [];
const neteaseDb = [];
const neteaseLyrics = new Map();
// 网易云的歌手（搜歌手、歌手页的热门 50 首）：{ id, name, alias, hot: [歌名…] }
const neteaseArtists = [];
const nn = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const DAY = 24 * 3600 * 1000;
// 每句隔 4 秒：[00:01.50]、[00:05.50]……
const lrcOf = words => words.map((w, i) => `[00:${String(1 + i * 4).padStart(2, '0')}.50]${w}`).join('\n');
const JPEG = n => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...bytesOf(n, n)]);

function serve(bytes, range, extraHeaders = {}) {
  if (!range) return new Response(bytes, { headers: { 'Content-Length': String(bytes.length), ...extraHeaders } });
  const [a, b] = range.replace('bytes=', '').split('-');
  const start = Number(a), end = b ? Number(b) : bytes.length - 1;
  return new Response(bytes.slice(start, end + 1), {
    status: 206, headers: { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ...extraHeaders },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers || {});
  calls.push({ url, range: headers.get('Range'), key: headers.get('X-Key') });
  let m;
  if ((m = url.match(/^https:\/\/streamer\.example\/photos\?upto=(\d+)$/))) {
    assert.equal(headers.get('X-Key'), SKEY);
    return Response.json({ photos: [...oldPhotos.keys()].filter(id => id <= Number(m[1])) });
  }
  if ((m = url.match(/^https:\/\/streamer\.example\/photo\/(\d+)$/))) {
    const img = oldPhotos.get(Number(m[1]));
    return img ? new Response(img, { headers: { 'Content-Type': 'image/jpeg' } }) : Response.json({ detail: 'Not Found' }, { status: 404 });
  }
  if ((m = url.match(/^https:\/\/streamer\.example\/thumb\/(\d+)$/))) {
    if (mode.thumbs === 'down') throw new TypeError('fetch failed');
    if (mode.thumbs === 'starting') return new Response('<html>starting</html>', { headers: { 'Content-Type': 'text/html' } });
    assert.equal(headers.get('X-Key'), SKEY);
    const img = thumbs.get(Number(m[1]));
    return img ? new Response(img, { headers: { 'Content-Type': 'image/jpeg' } }) : Response.json({ detail: 'Not Found' }, { status: 404 });
  }
  if ((m = url.match(/^https:\/\/streamer\.example\/viz\/(\d+)$/))) {
    if (mode.viz === 'down') throw new TypeError('fetch failed');
    if (mode.viz === 'starting') return new Response('<html>starting</html>', { headers: { 'Content-Type': 'text/html' } });
    assert.equal(headers.get('X-Key'), SKEY);
    if (Number(m[1]) === 404) return Response.json({ detail: 'Not Found' }, { status: 404 });
    return new Response(Uint8Array.from([0x58, 0x56, 1, 15, 2, 0x12, 0xf0, Number(m[1]) & 255]), { headers: { 'Content-Type': 'application/octet-stream' } });
  }
  if ((m = url.match(/^https:\/\/streamer\.example\/stream\/(\d+)$/))) {
    if (mode.streamer === 'down') throw new TypeError('fetch failed');
    if (mode.streamer === 'starting') return new Response('<html>Space is starting</html>', { headers: { 'Content-Type': 'text/html' } });
    if (mode.streamer === '502') return new Response('Bad Gateway', { status: 502 });
    assert.equal(headers.get('X-Key'), SKEY);
    const f = bigFiles.get(Number(m[1]));
    if (!f) return new Response('Not Found', { status: 404 });
    if (mode.streamer === 'short') return new Response(f.slice(0, 10), { status: headers.get('Range') ? 206 : 200, headers: { 'Content-Length': '10' } });
    return serve(f, headers.get('Range'), { 'Content-Type': 'application/octet-stream' });
  }
  if (url.startsWith('https://lrclib.net/api/search?')) {
    if (mode.lrclib === 'down') return new Response('oops', { status: 500 });
    assert.match(headers.get('User-Agent'), /xiaoju-music/);
    const p = new URL(url).searchParams;
    return Response.json(lrclibDb.filter(e => p.has('q')
      ? nn(p.get('q')).includes(nn(e.trackName))
      : nn(e.trackName).includes(nn(p.get('track_name'))) && (!p.has('artist_name') || nn(e.artistName).includes(nn(p.get('artist_name'))))));
  }
  if (url.startsWith('https://p1.music.126.net/')) {  // 网易云的专辑封面
    assert.match(url, /\?param=500y500$/);
    return new Response(new TextEncoder().encode('ALBUM:' + url.split('?')[0].split('/').pop()), { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url === 'https://music.163.com/api/cloudsearch/pc') {
    if (mode.netease === 'down') throw new TypeError('fetch failed');
    assert.equal(init.method, 'POST');
    assert.equal(headers.get('Referer'), 'https://music.163.com/');
    const q = nn(new URLSearchParams(init.body).get('s'));
    return Response.json({ code: 200, result: { songs: neteaseDb.filter(x => q.includes(nn(x.name.replace(/\s*[(（].*$/, '')))) } });
  }
  if (url.startsWith('https://music.163.com/api/search/get?')) {
    if (mode.netease === 'down') throw new TypeError('fetch failed');
    assert.equal(headers.get('Referer'), 'https://music.163.com/');
    const p = new URL(url).searchParams;
    assert.equal(p.get('type'), '100');
    const q = nn(p.get('s'));
    return Response.json({ code: 200, result: { artists: neteaseArtists.filter(a => nn(a.name).includes(q) || q.includes(nn(a.name)))
      .map(a => ({ id: a.id, name: a.name, alias: a.alias || [], picUrl: `http://p1.music.126.net/art${a.id}.jpg` })) } });
  }
  if ((m = url.match(/^https:\/\/music\.163\.com\/api\/artist\/top\/song\?id=(\d+)$/))) {
    const a = neteaseArtists.find(x => x.id === Number(m[1])) || { hot: [] };
    return Response.json({ code: 200, more: true, songs: a.hot.map((name, i) => ({ id: 1000 + i, name })) });
  }
  if ((m = url.match(/^https:\/\/music\.163\.com\/api\/song\/lyric\?id=(\d+)&/))) {
    return Response.json({ code: 200, lrc: { version: 1, lyric: neteaseLyrics.get(Number(m[1])) || '' } });
  }
  // 机器人要用的流式服务接口：记下收到的请求，按 bot 里设好的回
  if ((m = url.match(/^https:\/\/streamer\.example\/(fulfill|copy\/start|copy\/pick|auto\/start|auto\/status|search\/global|harvest|harvest\/count|harvest\/describe|harvest\/alts|harvest\/review(?:\/[a-z0-9]+)?|harvest\/status|harvest\/grey|harvest\/playlist|copy\/status|netease\/login|netease\/session|netease\/check)(?:\?(.*))?$/)) || url === STREAMER + '/') {
    if (bot.streamerDown) throw new TypeError('fetch failed');
    if (url === STREAMER + '/') return Response.json({ ok: true });
    assert.equal(headers.get('X-Key'), SKEY);
    const body = init.body ? JSON.parse(init.body) : null;
    bot.toStreamer.push({ path: m[1], body, query: m[2] || '' });
    if (m[1] === 'search/global') return Response.json({ results: bot.search });
    if (m[1] === 'copy/pick') return Response.json({ new_ids: [bot.pickId] });
    if (m[1] === 'copy/start' && bot.copyBusy) return Response.json({ detail: 'already running' }, { status: 409 });
    if (m[1] === 'auto/status') return Response.json(bot.autoStatus);
    if (m[1] === 'harvest/review') return Response.json(bot.review);
    if (m[1] === 'harvest/count') return Response.json(bot.count || {});
    if (m[1] === 'harvest/describe') return Response.json(bot.describe || {});
    if (m[1] === 'harvest/alts') return bot.harvestBusy ? Response.json({ detail: bot.harvestBusy }, { status: 409 }) : Response.json({ ok: true });
    if (m[1] === 'netease/session') return Response.json(bot.netease || {});
    if (m[1] === 'harvest/status') return Response.json(bot.harvestState || { status: 'idle' });
    if (m[1] === 'harvest/grey') return Response.json({ songs: bot.grey || [] });
    if (m[1] === 'harvest/playlist') return bot.playlist ? Response.json(bot.playlist) : Response.json({ detail: '这不是歌单的网址' }, { status: 400 });
    if (m[1] === 'copy/status') return Response.json(bot.copyState || { logged_in: true, status: 'idle' });
    if (m[1] === 'netease/check') return Response.json(bot.check || { login: false, songs: [], channel: { ok: true, title: '小橘🍊音乐' } });
    if (m[1].startsWith('harvest/review/')) return bot.sheet ? Response.json(bot.sheet) : Response.json({ detail: 'no such sheet' }, { status: 404 });
    if (m[1] === 'harvest') {
      if (/example\.com/.test(body.url)) return Response.json({ detail: '这个网站还不支持' }, { status: 400 });
      if (bot.harvestBusy) return Response.json({ detail: bot.harvestBusy }, { status: 409 });
      return Response.json({ ok: true, site: '网易云音乐 music.163.com' });
    }
    return Response.json({ ok: true });
  }
  assert.ok(url.startsWith('https://api.telegram.org/'), 'unexpected fetch ' + url);
  if (url.endsWith('/sendDocument')) {  // 发文件：multipart
    const f = init.body;
    bot.out.push({ method: 'sendDocument', chat_id: f.get('chat_id'), caption: f.get('caption'), name: f.get('document').name, text: await f.get('document').text() });
    return Response.json({ ok: true, result: { message_id: 9500 + bot.out.length } });
  }
  if (url.endsWith('/editMessageMedia')) {  // 替换消息里的文件：multipart，media 是 JSON，文件在 attach:// 指的字段里
    const f = init.body, media = JSON.parse(f.get('media')), doc = f.get(media.media.replace('attach://', ''));
    if (bot.deletedMsgs && bot.deletedMsgs.includes(Number(f.get('message_id')))) return Response.json({ ok: false, description: 'Bad Request: message to edit not found' });
    bot.out.push({ method: 'editMessageMedia', chat_id: f.get('chat_id'), message_id: Number(f.get('message_id')), caption: media.caption, name: doc.name, text: await doc.text() });
    return Response.json({ ok: true, result: {} });
  }
  if ((m = url.match(/\/bot[^/]+\/(sendMessage|answerCallbackQuery|getChatAdministrators|editMessageText|setMyCommands|editMessageReplyMarkup|deleteMessage|pinChatMessage)$/))) {
    const body = JSON.parse(init.body);
    if (m[1] === 'getChatAdministrators') {
      assert.equal(String(body.chat_id), String(CHANNEL));
      bot.adminAsks++;
      return Response.json({ ok: true, result: [{ status: 'administrator', user: { id: 1 } }, { status: 'creator', user: { id: OWNER } }] });
    }
    bot.out.push({ method: m[1], ...body });
    return Response.json({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 9000 + bot.out.length } : {} });
  }
  if ((m = url.match(/\/bot[^/]+\/getFile\?file_id=(.+)$/))) {
    const f = files.get(decodeURIComponent(m[1]));
    if (!f) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
    if (mode.getFile === 'fail') return Response.json({ ok: false, error_code: 500, description: 'Internal Server Error' });
    return Response.json({ ok: true, result: { file_path: 'music/' + m[1] + '.bin' } });
  }
  if ((m = url.match(/\/file\/bot[^/]+\/music\/(.+)\.bin$/))) {
    if (mode.expireOnce) { mode.expireOnce = false; return new Response('Not Found', { status: 404 }); }
    return serve(files.get(m[1]), headers.get('Range'));
  }
  throw new Error('unexpected fetch ' + url);
};

// ── 被测环境 ──
const oldTracks = [
  { id: 4, kind: 'audio', file_id: addFile(bytesOf(3000, 4)), file_unique_id: 'U4', title: '谁', performer: '张万森 @auvvip', name: '张万森 谁.mp3', mime: 'audio/mpeg', size: 3000, duration: 291, date: 1, caption: '' },
  { id: 12, kind: 'audio', file_id: 'BIG12', file_unique_id: 'U12', title: '抖音热播 Vol.12', performer: '', name: 'vol12.mp3', mime: 'audio/mpeg', size: 25 * MB, duration: 7209, date: 2, caption: '' },
];
bigFiles.set(12, bytesOf(25 * MB, 12));
const env = {
  TG_BOT_TOKEN: TOKEN, TG_WEBHOOK_SECRET: HOOK, ADMIN_KEY: ADMIN, STREAMER_KEY: SKEY, STREAMER_URL: STREAMER + '/',
  CHANNEL_ID: String(CHANNEL), CHANNEL_USERNAME: 'xiaojumusic', TRACKS: makeKV(oldTracks),
};
const lib = await makeLibrary(env);
env.LIB = { idFromName: n => n, get: () => lib };

const BASE = 'https://xiaoju-music.example.workers.dev';
const req = (path, init) => worker.fetch(new Request(BASE + path, init), env);
const hook = (update, secret = HOOK) => req('/tg-webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
});
const admin = (action, payload, key = ADMIN) => req('/admin/api/' + action, payload === undefined
  ? { headers: { Authorization: 'Bearer ' + key } }
  : { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const chat = { id: CHANNEL, type: 'channel', username: 'xiaojumusic', title: '小橘🍊音乐' };
const audioPost = (id, extra = {}) => ({ message_id: id, chat, date: 1700000000 + id, audio: { file_name: `song${id}.mp3`, mime_type: 'audio/mpeg', title: '歌' + id, file_unique_id: 'U' + id, ...extra } });

const seen = []; // 所有响应的开头和头部，最后查有没有泄露
async function bytes(res) {
  const b = new Uint8Array(await res.arrayBuffer());
  seen.push(new TextDecoder().decode(b.slice(0, 4000)) + JSON.stringify([...res.headers]));
  return b;
}
const textOf = async res => new TextDecoder().decode(await bytes(res));
const jsonOf = async res => JSON.parse(await textOf(res));
const publicTracks = async () => (await jsonOf(await req('/api/tracks'))).tracks;
const find = (list, id) => list.find(t => t.id === id);
const same = (got, src, from, to) => { assert.equal(got.length, to - from); assert.ok(Buffer.from(got).equals(Buffer.from(src.subarray(from, to))), `bytes ${from}-${to} 不一致`); };

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('ok', name); }

// ─────────────────────────────────────────────────────────────
await t('第一次启动把 KV 里的旧歌单迁进来（分页读全）；大文件在流式服务开着时可以播', async () => {
  const list = await publicTracks();
  assert.deepEqual(list.map(x => x.id), [12, 4]);
  assert.deepEqual([find(list, 4).big, find(list, 4).playable], [false, true]);
  assert.deepEqual([find(list, 12).big, find(list, 12).playable], [true, true]);
  assert.equal(find(list, 4).artist, '张万森'); // 「张万森 @auvvip」去掉转发来源
  assert.ok(!JSON.stringify(list).includes('file_id') && !JSON.stringify(list).includes('performer'));
});

await t('切片那一版的数据库：歌搬进 songs，状态列、chats 表、仓库配置都清掉，不再从 KV 重搬', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL)');
  db.exec('CREATE TABLE config (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?)').run(7, JSON.stringify({ ...oldTracks[0], id: 7, title: '旧版里的歌' }), 'ok', '', 0, 5);
  db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?)').run(51, JSON.stringify({ ...oldTracks[1], id: 51 }), 'pending', '没响应', 0, 6);
  db.exec("INSERT INTO chats VALUES ('-100999', '小橘仓库', 'administrator', 1)");
  db.exec("INSERT INTO config VALUES ('migrated', '1'), ('storage', '-100999'), ('storageTitle', '小橘仓库')");
  const old = await makeLibrary({ TRACKS: makeKV(oldTracks) }, db);
  assert.deepEqual((await old.listTracks()).map(x => x.id), [51, 7]); // 没有再从 KV 搬 4 和 12
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['artist_hot', 'asks', 'config', 'covers', 'grey', 'logo_covers', 'lyrics', 'memo', 'photos', 'playlists', 'songs', 'viz']);
  assert.deepEqual(db.prepare('SELECT k FROM config ORDER BY k').all().map(r => r.k), ['coversV', 'migrated']);
  await makeLibrary({}, db); // 再启动一次：什么都不用做，也不报错
  assert.equal((await old.getTrack(7)).title, '旧版里的歌');
});

await t('webhook：密钥错误 403；登记 mp3、m4a（纠正类型）、wav 文件、语音；非音频和别的聊天忽略', async () => {
  assert.equal((await hook({ channel_post: audioPost(5) }, 'wrong')).status, 403);
  await hook({ channel_post: audioPost(9, { file_id: addFile(bytesOf(5000, 9)), file_size: 5000, performer: '更多音乐 @auvvip' }) });
  await hook({ channel_post: audioPost(10, { file_name: '我太笨.m4a', file_id: addFile(bytesOf(100, 1)), file_size: 100 }) });
  await hook({ channel_post: { message_id: 11, chat, document: { file_name: 'Transformer interview .wav', mime_type: 'audio/x-wav', file_id: addFile(bytesOf(200, 2)), file_unique_id: 'U11', file_size: 200 } } });
  await hook({ channel_post: { message_id: 13, chat, voice: { duration: 5, mime_type: 'audio/ogg', file_id: addFile(bytesOf(50, 3)), file_unique_id: 'U13', file_size: 50 } } });
  await hook({ channel_post: { message_id: 14, chat, document: { file_name: 'a.png', mime_type: 'image/png', file_id: 'P', file_size: 9 } } });
  await hook({ channel_post: { message_id: 15, chat, document: { file_name: 'm.mp4', mime_type: 'video/mp4', file_id: 'V', file_size: 9 } } });
  await hook({ channel_post: { message_id: 16, chat, text: 'hello' } });
  await hook({ channel_post: { message_id: 17, chat: { id: -100555, type: 'channel' }, audio: { file_id: 'X', file_size: 1 } } });
  await hook({ message: { message_id: 18, chat: { id: 5, type: 'private' }, audio: { file_id: 'Y' } } });
  const list = await publicTracks();
  assert.deepEqual(list.map(x => x.id), [13, 12, 11, 10, 9, 4]);
  assert.equal(find(list, 10).mime, 'audio/mp4');
  assert.equal(find(list, 11).title, 'Transformer interview');
  assert.equal(find(list, 11).mime, 'audio/wav');
  assert.equal(find(list, 13).title, '语音 #13');
});

await t('歌单里的歌名和歌手：去掉「更多音乐」和 @频道；「歌手 - 歌名」拆开；有歌手时不拆', async () => {
  await hook({ channel_post: audioPost(60, { performer: '更多音乐 @auvvip', title: '泪海', file_id: 'X60', file_size: 9 }) });
  await hook({ channel_post: audioPost(61, { performer: '', title: '魏佳艺 - 掌心之中', file_id: 'X61', file_size: 9 }) });
  await hook({ channel_post: audioPost(62, { performer: '小柯', title: 'A - B', file_id: 'X62', file_size: 9 }) });
  const list = await publicTracks();
  assert.deepEqual([find(list, 60).title, find(list, 60).artist], ['泪海', '']);
  assert.deepEqual([find(list, 61).title, find(list, 61).artist], ['掌心之中', '魏佳艺']);
  assert.deepEqual([find(list, 62).title, find(list, 62).artist], ['A - B', '小柯']);
  for (const id of [60, 61, 62]) await admin('remove', { track: id });
});

await t('封面：新歌用 Bot API 取缩略图，取一次就存下，之后不再找 Telegram', async () => {
  const img = JPEG(300);
  await hook({ channel_post: audioPost(70, { file_id: addFile(bytesOf(10, 7)), file_size: 10, thumbnail: { file_id: addFile(img), width: 320, height: 320 } }) });
  calls.length = 0;
  let r = await req('/c/70');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'image/jpeg');
  assert.match(r.headers.get('Cache-Control'), /max-age=604800/);
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(img)));
  assert.equal(calls.filter(c => c.url.includes('api.telegram.org')).length, 2); // getFile + 下载
  calls.length = 0;
  r = await req('/c/70');
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(img)));
  assert.equal(calls.length, 0, '第二次直接从数据库出');
});

await t('封面：更早登记的歌（没记缩略图）请流式服务取，同样只取一次', async () => {
  const img = JPEG(500);
  thumbs.set(4, img);
  calls.length = 0;
  let r = await req('/c/4');
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(img)));
  assert.deepEqual(calls.map(c => [c.url, c.key]), [[STREAMER + '/thumb/4', SKEY]]);
  calls.length = 0;
  r = await req('/c/4');
  await bytes(r);
  assert.equal(calls.length, 0);
});

await t('封面：频道里一张图片都没有时记为没有；语音、不存在的歌 404', async () => {
  await hook({ channel_post: audioPost(71, { file_id: addFile(bytesOf(10, 8)), file_size: 10 }) }); // 帖子里没有缩略图
  calls.length = 0;
  let r = await req('/c/71');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('Cache-Control'), /max-age=86400/);
  await textOf(r);
  assert.deepEqual(calls.map(c => c.url), ['https://music.163.com/api/cloudsearch/pc', STREAMER + '/photos?upto=371'], '先找网易云的专辑封面，没有再扫一次频道图片');
  calls.length = 0;
  assert.equal((await req('/c/71')).status, 404);
  assert.equal(calls.length, 0, '记下「没有」后不再去取');
  assert.equal((await req('/c/999')).status, 404);
  await lib.putCover(71, 'none', ''); // 留着给下一项用
});

await t('封面：没有自带封面的歌，从频道图片帖里随机挑一张，挑定就不再变', async () => {
  const newPhoto = JPEG(90);
  // 新发的图片帖由 webhook 记下（带 Bot API 的 file_id），取边长不超过 800 的最大一档
  await hook({ channel_post: { message_id: 80, chat, photo: [
    { file_id: addFile(JPEG(10)), width: 90, height: 90 },
    { file_id: addFile(newPhoto), width: 800, height: 600 },
    { file_id: addFile(JPEG(20)), width: 1280, height: 960 },
  ] } });
  assert.deepEqual(await lib.listPhotos(), [{ id: 80, file_id: [...files.entries()].find(([, v]) => v === newPhoto)[0] }]);
  // 频道图片表读一次就记在内存里：配封面时不再每次整表读（免费版每天读的行数有限）；加了新图片才重读
  const photoReads = () => sqlLog.filter(q => /SELECT .* FROM photos/.test(q)).length;
  let before = photoReads();
  await lib.listPhotos(); await lib.listPhotos();
  assert.equal(photoReads(), before, '读过就不再读');
  await lib.addScannedPhotos([80]);  // 已经有的：表没变，但照样作废重读一次
  await lib.listPhotos(); await lib.listPhotos();
  assert.equal(photoReads(), before + 1, '加过图片重读一次');
  await hook({ channel_post: audioPost(73, { file_id: addFile(bytesOf(10, 3)), file_size: 10 }) });
  let r = await req('/c/73');
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(newPhoto)));
  calls.length = 0;
  r = await req('/c/73');
  await bytes(r);
  assert.equal(calls.length, 0, '挑定的图存下了');
  // 语音也用频道图片
  r = await req('/c/13');
  assert.equal(r.status, 200);
  await bytes(r);
  // 播放页要的是「自己的专辑图」（?art=1）：配的频道图片当没有，好让网页画文字封面；自带封面照给
  r = await req('/c/73?art=1');
  assert.equal(r.status, 404);
  await bytes(r);
  r = await req('/c/13?art=1');
  assert.equal(r.status, 404);
  await bytes(r);
  r = await req('/c/4?art=1');
  assert.equal(r.status, 200);
  await bytes(r);
  // 歌单接口带上 art：判断过封面的歌标 1/0，网页就不用一首首去试
  const arts = Object.fromEntries((await lib.listTracks()).map(t => [t.id, t.art]));
  assert.equal(arts[73], 0);
  assert.equal(arts[13], 0);
  assert.equal(arts[4], 1);
  for (const id of [71, 73]) await admin('remove', { track: id });
});

await t('封面：更早的图片帖（webhook 没见过）由流式服务扫出来、下载', async () => {
  const db = new DatabaseSync(':memory:');
  const fresh = await makeLibrary({}, db);
  const env2 = { ...env, LIB: { idFromName: n => n, get: () => fresh } };
  oldPhotos.set(5, JPEG(77));
  await fresh.upsertTrack({ id: 90, kind: 'audio', file_id: 'X90', file_unique_id: 'U90', thumb: '', title: '没封面', performer: '', name: 'a.flac', mime: 'audio/flac', size: 9, duration: 1, date: 1, caption: '' });
  const r = await worker.fetch(new Request(BASE + '/c/90'), env2);
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(oldPhotos.get(5))));
  assert.deepEqual(await fresh.listPhotos(), [{ id: 5, file_id: '' }]);
});

await t('封面：流式服务没醒（连不上、回网页）就 503，不存，醒了再取', async () => {
  // 模拟更早登记的歌：记录里没有 thumb 字段，只能请流式服务取
  await lib.upsertTrack({ id: 72, kind: 'audio', file_id: 'X72', file_unique_id: 'U72', title: '旧歌', performer: '', name: 'old.mp3', mime: 'audio/mpeg', size: 9, duration: 1, date: 1, caption: '' });
  thumbs.set(72, JPEG(200));
  for (const m of ['down', 'starting']) {
    mode.thumbs = m;
    const r = await req('/c/72');
    assert.equal(r.status, 503, m);
    assert.equal(r.headers.get('Retry-After'), '60');
    await textOf(r);
  }
  mode.thumbs = 'ok';
  const r = await req('/c/72');
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(thumbs.get(72))));
  await admin('remove', { track: 72 });
});

await t('封面：帖子换了文件就作废重取；删歌时封面一起删', async () => {
  const img2 = JPEG(120);
  await hook({ edited_channel_post: audioPost(70, { file_id: addFile(bytesOf(10, 9)), file_unique_id: 'U70-new', file_size: 10, thumbnail: { file_id: addFile(img2) } }) });
  let r = await req('/c/70');
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(img2)));
  await hook({ edited_channel_post: { ...audioPost(70, { file_id: 'same', file_unique_id: 'U70-new', file_size: 10, thumbnail: { file_id: 'unused' } }), caption: '只改说明' } });
  calls.length = 0;
  r = await req('/c/70');
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(img2)));
  assert.equal(calls.length, 0, '同一个文件，封面沿用');
  await admin('remove', { track: 70 });
  assert.equal((await lib.getCover(70)), null);
  await admin('remove', { track: 71 });
});

await t('歌词：LRCLIB 有时长对得上、带时间轴的就用它（歌手、时长不对的不要），存下来，下次不再出去找', async () => {
  await hook({ channel_post: audioPost(30, { title: '夜曲', performer: '周杰伦', duration: 226, file_id: 'X30', file_size: 9 }) });
  lrclibDb.push(
    { trackName: '夜曲', artistName: '别人', duration: 226, syncedLyrics: lrcOf(['翻唱1', '翻唱2', '翻唱3', '翻唱4', '翻唱5']) },
    { trackName: '夜曲', artistName: '周杰伦', duration: 250, syncedLyrics: lrcOf(['长版1', '长版2', '长版3', '长版4', '长版5']) },
    { trackName: '夜曲', artistName: '周杰伦', duration: 227.5, syncedLyrics: '[ti:夜曲]\n' + lrcOf(['一群嗜血的蚂蚁', '被腐肉所吸引', '我面无表情', '看孤独的风景', '失去你']) },
  );
  calls.length = 0;
  const r = await req('/l/30');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Cache-Control'), /max-age=300/);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  const d = await jsonOf(r);
  assert.equal(d.src, 'lrclib');
  assert.equal(d.synced, true);
  assert.equal(d.lines.length, 5);
  assert.deepEqual(d.lines[0], [1.5, '一群嗜血的蚂蚁']);
  assert.ok(calls.length && calls.every(c => c.url.startsWith('https://lrclib.net/')), 'LRCLIB 找到了就不问网易云');
  calls.length = 0;
  await jsonOf(await req('/l/30'));
  assert.equal(calls.length, 0, '第二次直接从数据库出');
});

await t('歌词：LRCLIB 没有就问网易云（挑时长最接近的）；网易云开头 JSON 格式的演职员行也认得', async () => {
  await hook({ channel_post: audioPost(31, { title: '谪仙 (DJ版)', performer: '伊格赛听、叶里', duration: 181, file_id: 'X31', file_size: 9 }) });
  neteaseDb.push({ id: 501, name: '谪仙', ar: [{ name: '伊格赛听' }], dt: 240000 }, { id: 502, name: '谪仙 (DJ版)', ar: [{ name: '伊格赛听' }, { name: '叶里' }], dt: 180500 });
  neteaseLyrics.set(501, lrcOf(['原版1', '原版2', '原版3', '原版4', '原版5']));
  neteaseLyrics.set(502, '{"t":0,"c":[{"tx":"作词: "},{"tx":"某某"}]}\n' + lrcOf(['画卷里的人', '一笔一画', '谪仙', '醉饮', '长歌']));
  const d = await jsonOf(await req('/l/31'));
  assert.equal(d.src, 'netease');
  assert.equal(d.synced, true);
  assert.deepEqual(d.lines.slice(0, 2), [[0, '作词: 某某'], [1.5, '画卷里的人']]);
});

await t('歌词：时长都对不上就只给文字；哪儿都没有记成「没有」、过段时间再找；外面出错时不乱下结论', async () => {
  await hook({ channel_post: audioPost(32, { title: '晴天', performer: '周杰伦', duration: 269, file_id: 'X32', file_size: 9 }) });
  lrclibDb.push({ trackName: '晴天', artistName: '周杰伦', duration: 309, syncedLyrics: lrcOf(['故事的小黄花', '从出生那年就飘着', '童年的荡秋千', '随记忆一直晃到现在', 'Re So So Si Do Si La']) });
  let d = await jsonOf(await req('/l/32'));
  assert.equal(d.src, 'lrclib');
  assert.equal(d.synced, false);
  assert.deepEqual(d.lines[0], [null, '故事的小黄花']);

  await hook({ channel_post: audioPost(33, { title: '没人唱过的歌', performer: '无名', duration: 100, file_id: 'X33', file_size: 9 }) });
  d = await jsonOf(await req('/l/33'));
  assert.deepEqual(d, { src: 'none', synced: false, lines: [] });
  const due = (await lib.getLyrics(33)).retry_at;
  assert.ok(due > Date.now() + 13 * DAY && due < Date.now() + 15 * DAY);
  calls.length = 0;
  await jsonOf(await req('/l/33'));
  assert.equal(calls.length, 0, '记成「没有」之后先不再找');
  await lib.putLyrics(33, 'none', '', Date.now() - 1); // 到了该再找的时候
  lrclibDb.push({ trackName: '没人唱过的歌', artistName: '无名', duration: 101, syncedLyrics: lrcOf(['终于', '有人', '写了', '这首', '歌词']) });
  d = await jsonOf(await req('/l/33'));
  assert.deepEqual([d.src, d.synced], ['lrclib', true]);
  assert.equal((await lib.getLyrics(33)).retry_at, 0);

  // LRCLIB 出错、网易云没有：先当没有，一天后就再找
  await hook({ channel_post: audioPost(34, { title: '另一首', performer: '无名', duration: 100, file_id: 'X34', file_size: 9 }) });
  mode.lrclib = 'down';
  d = await jsonOf(await req('/l/34'));
  assert.equal(d.src, 'none');
  assert.ok((await lib.getLyrics(34)).retry_at < Date.now() + 2 * DAY);
  // 两边都出错：503，什么都不存
  mode.netease = 'down';
  await hook({ channel_post: audioPost(35, { title: '第三首', performer: '无名', duration: 100, file_id: 'X35', file_size: 9 }) });
  let r = await req('/l/35');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Retry-After'), '60');
  await textOf(r);
  assert.equal(await lib.getLyrics(35), null);
  // 存着旧结果的歌到期再找，又碰上两边都出错：照旧给存着的
  await lib.putLyrics(34, 'none', '', Date.now() - 1);
  r = await req('/l/34');
  assert.equal(r.status, 200);
  await textOf(r);
  mode.lrclib = mode.netease = 'ok';
  assert.equal((await req('/l/999')).status, 404);
});

await t('歌词：频道里回复某首歌发 .lrc（UTF-8、GBK、UTF-16 都认）就配上，自动找到的盖不掉它', async () => {
  const gbk = Uint8Array.from([...Buffer.from('[00:01.00]'), 0xc4, 0xe3, 0xba, 0xc3, 0x0a, ...Buffer.from('[00:03.00]'), 0xd4, 0xd9, 0xbc, 0xfb]); // 你好、再见
  await hook({ channel_post: { message_id: 40, chat, document: { file_name: '随便起的名.lrc', mime_type: 'application/octet-stream', file_id: addFile(gbk), file_unique_id: 'L40', file_size: gbk.length }, reply_to_message: { message_id: 30, chat } } });
  assert.deepEqual(await jsonOf(await req('/l/30')), { src: 'manual', synced: true, lines: [[1, '你好'], [3, '再见']] });
  assert.equal((await lib.putLyrics(30, 'lrclib', lrcOf(['a', 'b', 'c', 'd', 'e']), 0)).src, 'manual', '自动结果盖不掉手动的');
  assert.ok(!(await publicTracks()).some(x => x.id === 40), '.lrc 帖子不算歌');

  // 没回复哪首：文件名「歌手 - 歌名.lrc」对上唯一一首。顺带：[offset]、一行多个时间、逐字时间、CRLF、[ti:] 标签
  const utf8 = new TextEncoder().encode('[ti:晴天]\r\n[offset:+500]\r\n[00:10.00][00:40.00]副歌\r\n[00:05.00]<00:05.00>第<00:05.40>一<00:05.80>句\r\n');
  await hook({ channel_post: { message_id: 41, chat, document: { file_name: '周杰伦 - 晴天.lrc', file_id: addFile(utf8), file_unique_id: 'L41', file_size: utf8.length } } });
  assert.deepEqual(await jsonOf(await req('/l/32')), { src: 'manual', synced: true, lines: [[4.5, '第一句'], [9.5, '副歌'], [39.5, '副歌']] });

  // 文件名谁也对不上、文件太大：不下载、不理
  calls.length = 0;
  assert.equal((await hook({ channel_post: { message_id: 42, chat, document: { file_name: '谁也不是.lrc', file_id: addFile(utf8), file_size: utf8.length } } })).status, 200);
  assert.equal((await hook({ channel_post: { message_id: 43, chat, document: { file_name: 'big.lrc', file_id: 'HUGE', file_size: 999999 }, reply_to_message: { message_id: 31, chat } } })).status, 200);
  assert.equal(calls.length, 0);
  assert.equal((await jsonOf(await req('/l/31'))).src, 'netease');

  // Windows 记事本存的 UTF-16（带 BOM），没有时间轴的纯文字也行
  const u16 = new Uint8Array(Buffer.from('\ufeff第一句\n第二句', 'utf16le'));
  await hook({ channel_post: { message_id: 44, chat, document: { file_name: 'x.lrc', file_id: addFile(u16), file_size: u16.length }, reply_to_message: { message_id: 31, chat } } });
  assert.deepEqual(await jsonOf(await req('/l/31')), { src: 'manual', synced: false, lines: [[null, '第一句'], [null, '第二句']] });
  // Telegram 出错也回 200（不让它反复重发）
  mode.getFile = 'fail';
  assert.equal((await hook({ channel_post: { message_id: 45, chat, document: { file_name: 'y.lrc', file_id: addFile(utf8), file_size: utf8.length }, reply_to_message: { message_id: 33, chat } } })).status, 200);
  mode.getFile = 'ok';
});

await t('歌词：帖子换了文件就作废；删歌时一起删', async () => {
  await hook({ edited_channel_post: audioPost(33, { title: '没人唱过的歌', performer: '无名', duration: 100, file_id: 'X33b', file_unique_id: 'U33-new', file_size: 9 }) });
  assert.equal(await lib.getLyrics(33), null);
  await admin('remove', { track: 30 });
  assert.equal(await lib.getLyrics(30), null);
  for (const id of [31, 32, 33, 34, 35]) await admin('remove', { track: id });
});

await t('查重：新帖和已有的歌名、歌手一样、时长差 3 秒以内就不登记；别的版本、编辑旧帖照常', async () => {
  await hook({ channel_post: audioPost(50, { title: '海阔天空', performer: 'Beyond', duration: 326, file_id: 'X50', file_size: 9 }) });
  await hook({ channel_post: audioPost(51, { title: '海阔天空', performer: 'Beyond @yinyue555', duration: 328, file_id: 'X51', file_size: 9 }) });
  await hook({ channel_post: audioPost(52, { title: 'Beyond - 海阔天空', performer: '', duration: 325, file_id: 'X52', file_size: 9 }) });
  await hook({ channel_post: audioPost(53, { title: '海阔天空', performer: 'Beyond', duration: 400, file_id: 'X53', file_size: 9 }) }); // 另一个版本
  await hook({ channel_post: audioPost(54, { title: '海阔天空', performer: '别人', duration: 326, file_id: 'X54', file_size: 9 }) }); // 翻唱
  let ids = (await publicTracks()).map(x => x.id);
  assert.ok(ids.includes(50) && !ids.includes(51) && !ids.includes(52) && ids.includes(53) && ids.includes(54));
  await hook({ edited_channel_post: audioPost(50, { title: '海阔天空', performer: 'Beyond', duration: 326, file_id: 'X50', file_size: 9 }) });
  assert.ok((await publicTracks()).some(x => x.id === 50), '编辑已登记的帖子不会把自己当重复');
  for (const id of [50, 53, 54]) await admin('remove', { track: id });
});

await t('封面：同一张图被 8 首歌当封面就是别的频道的台标，这些歌都改用频道图片，以后也不再用这张', async () => {
  const logo = JSON.stringify([...JPEG(33)]);
  const logoPost = id => audioPost(id, { file_id: 'L' + id, file_size: 9, thumbnail: { file_id: addFile(Uint8Array.from(JSON.parse(logo))) } });
  const isLogo = async id => Buffer.from(await bytes(await req('/c/' + id))).equals(Buffer.from(JSON.parse(logo)));
  for (let id = 600; id < 607; id++) {
    await hook({ channel_post: logoPost(id) });
    assert.ok(await isLogo(id), '前 7 首还当它是封面');
  }
  await hook({ channel_post: logoPost(607) });
  assert.ok(!(await isLogo(607)), '第 8 首认出是台标');
  for (let id = 600; id < 607; id++) assert.ok(!(await isLogo(id)), '之前的 7 首也换掉');
  await hook({ channel_post: logoPost(608) });
  assert.ok(!(await isLogo(608)), '记住了，以后也不用');
  for (let id = 600; id <= 608; id++) await admin('remove', { track: id });

  // 只有一两首用的台标认不出来：管理员可以手动说「这张封面不要了」
  const odd = [...JPEG(44)];
  for (const id of [610, 611]) await hook({ channel_post: audioPost(id, { file_id: 'M' + id, file_size: 9, thumbnail: { file_id: addFile(Uint8Array.from(odd)) } }) });
  const isOdd = async id => Buffer.from(await bytes(await req('/c/' + id))).equals(Buffer.from(odd));
  assert.ok((await isOdd(610)) && (await isOdd(611)));
  assert.equal((await jsonOf(await admin('ban-cover', { track: 610 }))).affected, 2);
  assert.ok(!(await isOdd(610)) && !(await isOdd(611)));
  assert.equal((await admin('ban-cover', { track: 'x' })).status, 400);
  for (const id of [610, 611]) await admin('remove', { track: id });
});

await t('歌单：管理员整体设置，跟着歌单 JSON 给出去；改名、排序保留 id，没列出的删掉；参数不对 400', async () => {
  assert.deepEqual((await jsonOf(await req('/api/tracks'))).playlists, []);
  assert.equal((await admin('playlists', { playlists: [{ name: '', tracks: [] }] })).status, 400);
  assert.equal((await admin('playlists', { playlists: [{ name: 'x', tracks: ['a'] }] })).status, 400);
  assert.equal((await admin('playlists', { playlists: [{ name: 'x', tracks: [] }] }, 'wrong')).status, 401);
  let r = await jsonOf(await admin('playlists', { playlists: [{ name: ' 抖音热歌 ', tracks: [9, 10, 9] }, { name: '经典老歌', cover: 4, tracks: [4] }] }));
  const [hot, old] = r.playlists;
  assert.deepEqual([hot.name, hot.tracks, old.cover], ['抖音热歌', [9, 10], 4]);
  assert.deepEqual((await jsonOf(await req('/api/tracks'))).playlists.map(p => p.name), ['抖音热歌', '经典老歌']);
  r = await jsonOf(await admin('playlists', { playlists: [{ id: old.id, name: '经典', tracks: [4, 9] }, { name: '新的', tracks: [] }] }));
  assert.deepEqual(r.playlists.map(p => [p.id === old.id, p.name, p.tracks]), [[true, '经典', [4, 9]], [false, '新的', []]]);
  assert.ok(!r.playlists.some(p => p.id === hot.id), '没列出的歌单删掉');
  assert.deepEqual((await jsonOf(await admin('state'))).playlists.map(p => p.name), ['经典', '新的']);
  await admin('playlists', { playlists: [] });
});

await t('新歌自动分歌单：按歌名关键词和歌手放进对应歌单；MV 不进；编辑旧帖不重新分；只放进已有的歌单', async () => {
  const names = ['抖音热歌', '华语流行', '伤感情歌', '经典老歌', '粤语金曲', 'DJ 劲爆', '重低音', '现场 Live'];
  await admin('playlists', { playlists: names.map(name => ({ name, tracks: name === '经典老歌' ? [1] : [] })) });
  const post = (id, title, performer) => hook({ channel_post: audioPost(id, { file_id: addFile(bytesOf(10, id)), file_size: 10, title, performer }) });
  await post(901, '吻别 (DJ版)', '张学友');
  await post(902, '晴天', '周杰伦');
  await post(903, '某某 MV', '张学友');
  await post(904, '超重低音车载串烧', '');
  await post(905, '无名小曲', '某个新人');
  await post(906, '想你的夜 (Live)', '关喆');
  await post(907, '闽A轩少专属Vol.3', '');
  const pl = Object.fromEntries((await lib.listPlaylists()).map(p => [p.name, p.tracks]));
  assert.deepEqual(pl['DJ 劲爆'], [907, 904, 901]);
  assert.deepEqual(pl['经典老歌'], [901, 1], '放在最前面，原来的不动');
  assert.deepEqual(pl['粤语金曲'], [901]);
  assert.deepEqual(pl['华语流行'], [905, 902], '对不上关键词、有歌手名的进华语流行');
  assert.deepEqual(pl['重低音'], [904]);
  assert.deepEqual(pl['现场 Live'], [906]);
  assert.deepEqual(pl['伤感情歌'], [906]);
  assert.ok(!Object.values(pl).some(t => t.includes(903)), 'MV 不进歌单');
  // 编辑已登记的帖子：不再动歌单（管理员可能已经手动调过）
  await lib.removeFromPlaylist(902, '华语流行');
  await hook({ edited_channel_post: audioPost(902, { file_id: addFile(bytesOf(10, 902)), file_size: 10, title: '晴天', performer: '周杰伦' }) });
  assert.ok(!(await lib.listPlaylists()).find(p => p.name === '华语流行').tracks.includes(902));
  for (const id of [901, 902, 903, 904, 905, 906, 907]) await admin('remove', { track: id });
  await admin('playlists', { playlists: [] });
});

await t('重新配图：只清掉用频道图片的歌（语音、确定没有自带缩略图的、和别首共用一张图的老歌），自带封面的不动', async () => {
  await lib.upsertTrack({ id: 620, kind: 'audio', file_id: 'a', file_unique_id: 'u620', thumb: '', title: '没封面', performer: '', name: 'a.mp3', mime: 'audio/mpeg', size: 9, duration: 1, date: 1, caption: '' });
  await lib.upsertTrack({ id: 621, kind: 'audio', file_id: 'b', file_unique_id: 'u621', thumb: 'T', title: '有封面', performer: '', name: 'b.mp3', mime: 'audio/mpeg', size: 9, duration: 1, date: 1, caption: '' });
  await lib.upsertTrack({ id: 622, kind: 'audio', file_id: 'c', file_unique_id: 'u622', title: '老歌共用图', performer: '', name: 'c.mp3', mime: 'audio/mpeg', size: 9, duration: 1, date: 1, caption: '' });
  await lib.upsertTrack({ id: 623, kind: 'audio', file_id: 'd', file_unique_id: 'u623', title: '老歌自己的图', performer: '', name: 'd.mp3', mime: 'audio/mpeg', size: 9, duration: 1, date: 1, caption: '' });
  await lib.putCover(620, 'image/jpeg', 'PHOTO');
  await lib.putCover(621, 'image/jpeg', 'OWN');
  await lib.putCover(622, 'image/jpeg', 'PHOTO');
  await lib.putCover(623, 'image/jpeg', 'OWN2');
  const r = await jsonOf(await admin('reshuffle-photo-covers', {}));
  assert.ok(r.cleared >= 2); // 前面测试留下的、用频道图片的歌也会一起清掉
  assert.equal(await lib.getCover(620), null);
  assert.equal(await lib.getCover(622), null);
  assert.equal((await lib.getCover(621)).b64, 'OWN');
  assert.equal((await lib.getCover(623)).b64, 'OWN2');
  for (const id of [620, 621, 622, 623]) await admin('remove', { track: id });
});

await t('音乐来源频道名单：管理员读写，去掉 @ 和重复，名字不对 400', async () => {
  assert.deepEqual((await jsonOf(await admin('sources'))).sources, []);
  assert.equal((await admin('sources', { sources: ['ok_name', 'x'] })).status, 400);
  const r = await jsonOf(await admin('sources', { sources: ['@VmoMusic', 'dj225', 'VmoMusic'] }));
  assert.deepEqual(r.sources, ['VmoMusic', 'dj225']);
  assert.deepEqual((await jsonOf(await admin('sources'))).sources, ['VmoMusic', 'dj225']);
  assert.equal((await admin('sources', { sources: [] }, 'wrong')).status, 401);
  await admin('sources', { sources: [] });
});

await t('大文件：Range 原样转给流式服务（带密钥），返回的字节和原文件一致', async () => {
  const src = bigFiles.get(12);
  const N = src.length;
  calls.length = 0;
  let r = await req('/a/12', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), `bytes 0-1/${N}`);
  assert.equal(r.headers.get('Content-Type'), 'audio/mpeg');
  same(await bytes(r), src, 0, 2);
  assert.deepEqual(calls.map(c => [c.url, c.range, c.key]), [[STREAMER + '/stream/12', 'bytes=0-1', SKEY]]);
  assert.ok(!calls.some(c => c.url.includes('api.telegram.org')), '大文件不走 Bot API');

  r = await req('/a/12', { headers: { Range: `bytes=${N - 1000}-` } });
  assert.equal(r.headers.get('Content-Range'), `bytes ${N - 1000}-${N - 1}/${N}`);
  same(await bytes(r), src, N - 1000, N);

  r = await req('/a/12', { headers: { Range: 'bytes=-5' } });
  assert.equal(calls.at(-1).range, `bytes=${N - 5}-${N - 1}`); // 转发的是算好的绝对范围
  same(await bytes(r), src, N - 5, N);

  calls.length = 0;
  r = await req('/a/12?dl=1'); // 整个下载：不带 Range，200
  assert.equal(r.status, 200);
  assert.equal(calls[0].range, null);
  assert.equal(r.headers.get('Content-Length'), String(N));
  assert.match(r.headers.get('Content-Disposition'), /^attachment;/);
  same(await bytes(r), src, 0, N);

  r = await req('/a/12', { headers: { Range: `bytes=${N}-` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('Content-Range'), `bytes */${N}`);
  r = await req('/a/12', { method: 'HEAD' });
  assert.equal(r.headers.get('Content-Length'), String(N));
});

await t('流式服务在休眠：连不上、回「正在启动」网页、回 502 都算正在唤醒（503 + Retry-After）', async () => {
  for (const m of ['down', 'starting', '502']) {
    mode.streamer = m;
    const r = await req('/a/12', { headers: { Range: 'bytes=0-1' } });
    assert.equal(r.status, 503, m);
    assert.equal(r.headers.get('Retry-After'), '15');
    assert.match(await textOf(r), /唤醒/);
  }
  mode.streamer = 'short'; // 给的字节数不对：不能当音频转出去
  let r = await req('/a/12', { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 502);
  await textOf(r);
  mode.streamer = 'ok';
  bigFiles.delete(12); // 频道里的帖子被删了
  r = await req('/a/12', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 404);
  assert.match(await textOf(r), /找不到/);
  bigFiles.set(12, bytesOf(25 * MB, 12));
});

await t('没配流式服务：大文件标成不能播放，请求返回 503 说明原因；小文件不受影响', async () => {
  const saved = env.STREAMER_URL;
  env.STREAMER_URL = '';
  await hook({ channel_post: audioPost(20, { file_id: 'BIG20', file_size: 21 * MB }) }); // 顺便清掉歌单缓存
  const list = await publicTracks();
  assert.equal(find(list, 20).playable, false);
  assert.equal(find(list, 12).playable, false);
  assert.equal(find(list, 9).playable, true);
  const r = await req('/a/12');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Retry-After'), null);
  assert.match(await textOf(r), /暂时不能/);
  const s = await jsonOf(await admin('state'));
  assert.equal(s.streamer, false);
  env.STREAMER_URL = saved;
  await hook({ channel_post: audioPost(20, { file_id: 'BIG20', file_size: 21 * MB }) });
  assert.equal(find(await publicTracks(), 20).playable, true);
});

await t('小文件：Range 透传；下载路径过期重取；Telegram 故障 502；多段 Range 给整个文件', async () => {
  const f9 = files.get((await lib.getTrack(9)).file_id);
  let r = await req('/a/9', { headers: { Range: 'bytes=10-109' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 10-109/5000');
  same(await bytes(r), f9, 10, 110);
  calls.length = 0;
  mode.expireOnce = true;
  r = await req('/a/9', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  await bytes(r);
  assert.equal(calls.filter(c => c.url.includes('/getFile')).length, 1);
  assert.equal(calls.filter(c => c.url.includes('/file/bot')).length, 2);
  r = await req('/a/9', { headers: { Range: 'bytes=0-1,5-6' } });
  assert.equal(r.status, 200);
  same(await bytes(r), f9, 0, 5000);
  mode.getFile = 'fail';
  r = await req('/a/11');
  mode.getFile = 'ok';
  assert.equal(r.status, 502);
  await textOf(r);
  r = await req('/a/10?dl=1');
  assert.match(r.headers.get('Content-Disposition'), /^attachment; filename="track-10\.m4a"; filename\*=UTF-8''%E6%88%91%E5%A4%AA%E7%AC%A8\.m4a$/);
  await bytes(r);
});

await t('编辑成纯文字 → 移除；管理页也能移除；管理接口要密钥且不带 CORS 头', async () => {
  await hook({ edited_channel_post: { message_id: 13, chat, text: '不是音频了' } });
  assert.equal((await admin('state', undefined, 'wrong')).status, 401);
  assert.equal((await req('/admin/api/state')).status, 401);
  const r = await admin('state');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  const s = await jsonOf(r);
  assert.equal(s.streamer, true);
  assert.equal(find(s.tracks, 12).big, true);
  assert.equal((await admin('remove', { track: 'x' })).status, 400);
  assert.equal((await admin('remove', { track: 4 })).status, 200);
  const ids = (await publicTracks()).map(x => x.id);
  assert.ok(!ids.includes(13) && !ids.includes(4));
  assert.equal((await req('/a/4')).status, 404);
});

await t('音柱数据：第一次请流式服务算，存下来；算不了记住；服务没起来不记；换了文件要重算', async () => {
  for (const id of [810, 811, 404]) await hook({ channel_post: audioPost(id, { file_id: addFile(bytesOf(10, id)), file_size: 10 }) });
  calls.length = 0;
  let r = await req('/v/810');
  assert.equal(r.status, 200);
  assert.deepEqual([...await bytes(r)], [0x58, 0x56, 1, 15, 2, 0x12, 0xf0, 810 & 255]);
  r = await req('/v/810');
  await bytes(r);
  assert.equal(calls.filter(c => c.url.includes('/viz/')).length, 1, '算过的直接给');
  r = await req('/v/404');
  assert.equal(r.status, 404);
  await bytes(r);
  calls.length = 0;
  assert.equal((await req('/v/404')).status, 404);
  assert.equal(calls.length, 0, '算不了的记住，不再问');
  mode.viz = 'starting';
  r = await req('/v/811');
  assert.equal(r.status, 503);
  await bytes(r);
  mode.viz = 'down';
  assert.equal((await req('/v/811')).status, 503);
  mode.viz = 'ok';
  assert.equal((await req('/v/811')).status, 200, '服务好了再算');
  assert.equal((await req('/v/9999')).status, 404, '没有这首歌');
  // 帖子换了文件：旧数据作废
  await hook({ edited_channel_post: audioPost(810, { file_id: addFile(bytesOf(12, 1)), file_size: 12, file_unique_id: 'U810b' }) });
  assert.equal(await lib.getViz(810), null);
  await admin('remove', { track: 811 });
  assert.equal(await lib.getViz(811), null);
  for (const id of [810, 404]) await admin('remove', { track: id });
});

// 私聊机器人：from 是谁，发什么
const dm = (from, text) => hook({ update_id: 1, message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } });
const press = (from, data) => hook({ update_id: 2, callback_query: { id: 'cb', from: { id: from }, message: { message_id: 9, chat: { id: from, type: 'private' } }, data } });
const lastSay = () => bot.out.filter(o => o.method === 'sendMessage').at(-1);

await t('机器人：频道主是频道创建者（问一次就记住）；频道主和听众看到不同的说明；群里的消息不理', async () => {
  bot.out.length = 0;
  await dm(OWNER, '/start');
  assert.match(lastSay().text, /管理助手/);
  await dm(FAN, '/start');
  assert.match(lastSay().text, /发一个歌名给我/);
  assert.equal(bot.adminAsks, 1, '频道主记住了，不重复问');
  const n = bot.out.length;
  await hook({ update_id: 3, message: { message_id: 2, from: { id: FAN }, chat: { id: -5, type: 'group' }, text: '晴天' } });
  assert.equal(bot.out.length, n);
});

await t('求歌：库里有直接给链接；没有就请流式服务去找（带来源频道和链接前缀）；每人每天限 10 次；服务睡着时说一声', async () => {
  await admin('sources', { sources: ['VmoMusic', 'yinyue555'] });
  await hook({ channel_post: audioPost(970, { file_id: addFile(bytesOf(10, 970)), file_size: 10, title: '谁', performer: '张万森' }) });
  await dm(FAN, '谁');
  assert.match(lastSay().text, /小橘音乐里有：张万森 - 谁/);
  assert.ok(lastSay().text.includes(BASE + '/#970'));
  bot.toStreamer.length = 0;
  await dm(FAN, '晴天');
  assert.match(lastSay().text, /我去找找/);
  const f = bot.toStreamer.find(x => x.path === 'fulfill').body;
  assert.equal(f.q, '晴天');
  assert.equal(f.chat_id, FAN);
  assert.deepEqual(f.only, ['VmoMusic', 'yinyue555']);
  assert.equal(f.link, BASE + '/');
  assert.ok(f.existing.some(([t, a]) => t === '谁' && a === '张万森'));
  for (let i = 0; i < 9; i++) await dm(FAN, '晴天' + i);
  await dm(FAN, '稻香');
  assert.match(lastSay().text, /有点多/);
  await dm(OWNER, '稻香'); // 频道主不限次
  assert.match(lastSay().text, /我去找找/);
  bot.streamerDown = true;
  await dm(OWNER, '七里香');
  assert.match(lastSay().text, /睡觉/);
  bot.streamerDown = false;
  await dm(FAN, 'x'.repeat(70));
  assert.match(lastSay().text, /太长/);
  await admin('remove', { track: 970 });
});

await t('频道主：搜 → 列出来带「搬」按钮；按按钮请流式服务搬；别人按没用', async () => {
  bot.search = [{ channel: 'VmoMusic', id: 321, title: '晴天', performer: '周杰伦', duration: 269 }, { channel: 'VmoMusic', id: 322, title: '晴天片段', performer: '', duration: 20 }];
  await dm(OWNER, '搜 晴天');
  const m = lastSay();
  assert.match(m.text, /1\. 周杰伦 - 晴天（4:29，@VmoMusic）/);
  assert.ok(!m.text.includes('片段'), '太短的片段不列');
  assert.deepEqual(m.reply_markup.inline_keyboard, [[{ text: '搬 1', callback_data: 'p:VmoMusic:321' }]]);
  assert.ok(bot.toStreamer.at(-1).query.includes('only=VmoMusic%2Cyinyue555'));
  bot.pickId = 4321;
  await press(OWNER, 'p:VmoMusic:321');
  assert.deepEqual(bot.toStreamer.at(-1), { path: 'copy/pick', body: { items: [{ channel: 'VmoMusic', id: 321 }] }, query: '' });
  assert.ok(lastSay().text.includes(BASE + '/#4321'));
  bot.pickId = 0;
  await press(OWNER, 'p:VmoMusic:999');
  assert.match(lastSay().text, /搬不了/);
  const n = bot.toStreamer.length;
  await press(FAN, 'p:VmoMusic:321');
  assert.equal(bot.toStreamer.length, n);
  assert.equal(bot.out.at(-1).text, '只有频道主能用');
});

await t('频道主：搬 @频道 N → 请流式服务搬（中文、查重、搬完通知频道主）；正在搬别的时说一声', async () => {
  await dm(OWNER, '搬 @haoyyup 120');
  const b = bot.toStreamer.at(-1).body;
  assert.deepEqual([b.source, b.limit, b.notify, b.chinese_only, b.min_seconds, b.max_seconds], ['haoyyup', 120, OWNER, true, 60, 1200]);
  assert.match(lastSay().text, /开始从 @haoyyup 搬最多 120 首/);
  bot.copyBusy = true;
  await dm(OWNER, '搬 yinyue555');
  assert.match(lastSay().text, /正在搬别的/);
  bot.copyBusy = false;
  await dm(FAN + 1, '搬 @haoyyup 120'); // 听众发这个只当求歌（换一个还没用完次数的听众）
  assert.equal(bot.toStreamer.at(-1).path, 'fulfill');
});

await t('频道主：找 → 加入/移出歌单、删除（要确认）；统计', async () => {
  await admin('playlists', { playlists: [{ name: '抖音热歌', tracks: [] }, { name: '华语流行', tracks: [] }] });
  await hook({ channel_post: audioPost(960, { file_id: addFile(bytesOf(10, 960)), file_size: 10, title: '测试小曲', performer: '小橘' }) });
  const pls = await lib.listPlaylists();
  const hot = pls.find(p => p.name === '抖音热歌'), pop = pls.find(p => p.name === '华语流行');
  assert.ok(pop.tracks.includes(960), '新歌自动进了华语流行');
  await dm(OWNER, '找 测试小曲');
  assert.match(lastSay().text, /小橘 - 测试小曲\n在歌单：华语流行/);
  await press(OWNER, 'a:960');
  assert.deepEqual(lastSay().reply_markup.inline_keyboard, [[{ text: '抖音热歌', callback_data: `ap:960:${hot.id}` }]]);
  await press(OWNER, `ap:960:${hot.id}`);
  assert.ok((await lib.listPlaylists()).find(p => p.name === '抖音热歌').tracks.includes(960));
  await press(OWNER, `rp:960:${pop.id}`);
  assert.ok(!(await lib.listPlaylists()).find(p => p.name === '华语流行').tracks.includes(960));
  await dm(OWNER, '统计');
  assert.match(lastSay().text, /歌库一共 \d+ 首/);
  assert.match(lastSay().text, /抖音热歌 1 首/);
  await press(OWNER, 'd:960');
  assert.match(lastSay().text, /确定从小橘音乐删除/);
  assert.ok(await lib.getTrack(960), '没确认前不删');
  await press(OWNER, 'dd:960');
  assert.equal(await lib.getTrack(960), null);
  await dm(OWNER, '找 不存在的歌');
  assert.match(lastSay().text, /没有「不存在的歌」/);
  await admin('playlists', { playlists: [] });
});

await t('贴网址搬运：搬运设置可以开关网站和授权、改数量和歌单；网址连同设置交给流式服务；搬来的歌进指定歌单', async () => {
  await admin('playlists', { playlists: [{ name: '华语流行', tracks: [] }] });
  await dm(OWNER, '搬运设置');
  const panel = lastSay();
  assert.match(panel.text, /每次最多抓：20 首/);
  assert.match(panel.text, /支持：网易云音乐（贴网址，或发「爬 歌名或歌手」去上面搜）。抓到的全部进审核单/);
  assert.equal(panel.reply_markup, undefined, '没有网站、授权开关了');
  await dm(OWNER, '搬运数量 30');
  await dm(OWNER, '搬运歌单 纯音乐');
  assert.match(lastSay().text, /新建了这个歌单/);
  assert.deepEqual((await lib.listPlaylists()).map(p => p.name), ['华语流行', '纯音乐']);
  await dm(OWNER, '分享小橘的单曲《晴天》: https://163cn.tv/abc (来自@网易云音乐)');
  const h = bot.toStreamer.at(-1);
  assert.equal(h.path, 'harvest');
  assert.equal(h.body.url, 'https://163cn.tv/abc', 'App 分享的整段文字也行');
  assert.deepEqual(h.body.settings, { limit: 30, playlist: '纯音乐', channel: '', sites: ['netease'] });
  assert.equal(h.body.notify, OWNER);
  assert.equal(h.body.link, BASE, '审核单里「查看全部」的网址');
  assert.match(lastSay().text, /开始从网易云音乐 music.163.com抓，最多 30 首。抓完发审核单给你/);
  await dm(OWNER, 'https://music.163.com/#/artist?id=9 5');
  assert.equal(bot.toStreamer.at(-1).body.settings.limit, 5, '网址后面的数量只管这一次');
  await dm(OWNER, 'https://music.example.com/song/1');
  assert.match(lastSay().text, /这个网站还不支持。现在支持：网易云音乐/);
  // 一次只做一单：上一单还在发，说清楚在忙什么；服务刚启动（搬运还没准备好）不说成在忙
  bot.harvestBusy = { busy: '正在把审核通过的 20 首发进频道（已发 5 首，处理到第 6 首）' };
  await dm(OWNER, 'https://music.163.com/#/song?id=1 5');
  assert.equal(lastSay().text, '上一单还没做完：正在把审核通过的 20 首发进频道（已发 5 首，处理到第 6 首）。一次只做一单（抓 → 审核 → 发），做完会通知你，到时再发这个网址。');
  bot.harvestBusy = 'not ready';
  await dm(OWNER, 'https://music.163.com/#/song?id=1 5');
  assert.match(lastSay().text, /搬运服务正在启动/);
  bot.harvestBusy = null;
  // 主页（歌手主页、音乐人的用户主页）：记成小号，马上同步，新歌不审核直接发
  bot.describe = { site: '网易云音乐 music.163.com', kind: 'artist', name: '小橘', id: '9' };
  neteaseArtists.push({ id: 9, name: '小橘', hot: ['小橘最火的歌', '第二火的'] });
  await dm(OWNER, '搬运频道 正式');
  const before = bot.toStreamer.length;
  await dm(OWNER, 'https://music.163.com/#/user/home?id=77 5');
  assert.deepEqual(bot.toStreamer.slice(before).map(x => x.path), ['harvest/describe', 'netease/session', 'harvest/alts'], '主页写了数量也是小号');
  let cnt = bot.toStreamer.at(-1);
  assert.equal(cnt.path, 'harvest/alts');
  assert.deepEqual(cnt.body.alts, [{ url: 'https://music.163.com/artist?id=9', name: '小橘' }]);
  assert.equal(cnt.body.notify, OWNER);
  assert.ok(Array.isArray(cnt.body.existing) && 'cookie' in cnt.body && cnt.body.channel === '');
  const told = bot.out.filter(o => o.method === 'sendMessage').slice(-2).map(o => o.text);
  assert.match(told[0], /加了小号「小橘」（第 1 个）。以后它热门前 50 首里库里没有的，不用审核，直接发进频道/);
  assert.match(told[1], /开始同步小号「小橘」：每个号看热门前 50 首，库里没有的直接发进频道，不用审核.*发「进度」/);
  // 进度：同步小号做到哪了
  bot.harvestState = { status: 'running', kind: 'direct', alts: ['小橘'], total: 0, copied: 0, have: 0, results: [] };
  await dm(OWNER, '⏳ 进度');
  assert.equal(lastSay().text, '🔄 正在同步小号「小橘」：在看热门前 50 首，找库里没有的');
  bot.harvestState = { ...bot.harvestState, total: 12, copied: 3, have: 38, results: [1, 2, 3, 4] };
  bot.copyState = { logged_in: true, status: 'running', mode: 'auto', scanned: 40, copied: 5, skipped_dup: 2, skipped_lang: 1, skipped_other: 0 };
  await dm(OWNER, '进度');
  assert.equal(lastSay().text, '🔄 正在同步小号「小橘」：12 首新歌，已发 3 首，处理到第 4 首；38 首库里已有，不发\n\n🔄 正在夜里自动搬：看了 40 首，搬了 5 首，跳过 3 首');
  bot.harvestState = { status: 'error', kind: 'direct', alts: ['小橘'], total: 12, copied: 7, have: 38, results: [], error: 'RuntimeError: 网易云接口出错' };
  bot.copyState = null;
  await dm(OWNER, '进度');
  assert.equal(lastSay().text, '✅ 上一单（同步小号「小橘」）出错停了（RuntimeError: 网易云接口出错），发了 7 首，没发 5 首；38 首库里已有，不发');
  bot.harvestState = null;
  await dm(OWNER, '进度');
  assert.match(lastSay().text, /^现在没有在搬的活/);
  bot.streamerDown = true;
  await dm(OWNER, '进度');
  assert.equal(lastSay().text, '搬运服务正在唤醒，过一两分钟再发「进度」');
  bot.streamerDown = false;
  assert.deepEqual((await lib.listHot()).songs['小橘'], ['小橘最火的歌', '第二火的'], '同步小号时马上记下热门 50 首，歌手页不用等后台');
  assert.equal((await lib.listHot()).pics['小橘'], 'https://p1.music.126.net/art9.jpg', '按小号的编号认人，顺带记下头像');
  await dm(OWNER, 'https://music.163.com/artist?id=9');
  assert.match(bot.out.filter(o => o.method === 'sendMessage').at(-2).text, /已经是小号了/);
  assert.equal(JSON.parse(await lib.getConfig('neteaseAlts')).length, 1, '同一个号不加两次');
  bot.describe = { ...bot.describe, name: '朋友', id: '10' };
  await dm(OWNER, 'https://music.163.com/artist?id=10');
  await dm(OWNER, '👥 小号');
  assert.match(lastSay().text, /1\. 小橘\n   https:\/\/music\.163\.com\/artist\?id=9\n2\. 朋友/);
  await dm(OWNER, '同步小号');
  assert.deepEqual(bot.toStreamer.at(-1).body.alts.map(a => a.name), ['小橘', '朋友']);
  bot.harvestBusy = { busy: '正在同步小号：在找新歌' };
  await dm(OWNER, '同步小号');
  assert.match(lastSay().text, /上一单还没做完：正在同步小号：在找新歌/);
  bot.harvestBusy = null;
  // 自检：查登录、试下载小号热门歌、看频道能不能发；结果也在「搬运设置」里
  bot.check = { login: true, nickname: '小橘', vip: 0, songs: [{ title: '甲', ok: true, size: 9, ext: 'mp3' }, { title: '乙', ok: false, why: '网易云只给试听片段（会员过期了？续上再发「网易云登录」）' }], channel: { ok: true, title: '小橘🍊音乐' } };
  await dm(OWNER, '自检');
  const chk = bot.toStreamer.filter(x => x.path === 'netease/check').at(-1);
  assert.deepEqual(chk.body.alts, ['https://music.163.com/artist?id=9', 'https://music.163.com/artist?id=10']);
  assert.equal(typeof chk.body.cookie, 'string', '带上存着的网易云账号（这里还没登录，是空的）');
  assert.match(lastSay().text, /· 网易云：已登录「小橘」\n· 试下载小号热门歌 2 首：1 首能下完整的；乙：网易云只给试听片段/);
  assert.match(lastSay().text, /· 频道：能往「小橘🍊音乐」发帖/);
  assert.ok(!lastSay().text.includes('secretcookie'));
  await dm(OWNER, '搬运设置');
  assert.match(lastSay().text, /自检（[\d- :]+）：\n· 网易云：已登录「小橘」/);
  bot.check = null;
  await dm(OWNER, '删除小号 2');
  assert.match(lastSay().text, /删掉了小号「朋友」/);
  await dm(OWNER, '删除小号 5');
  assert.match(lastSay().text, /没有这个编号/);
  // 专辑、歌单（没写数量）：先数一数，按按钮再抓（照旧出审核单）
  bot.describe = { site: '网易云音乐 music.163.com', kind: 'album', name: '晴天', id: '5' };
  bot.count = { site: '网易云音乐 music.163.com', kind: 'album', name: '晴天', total: 120, have: 30 };
  await dm(OWNER, 'https://music.163.com/album?id=5');
  assert.equal(bot.toStreamer.at(-1).path, 'harvest/count');
  assert.match(lastSay().text, /^专辑「晴天」：一共 120 首，小橘音乐里已有 30 首，没搬的 90 首。\n要抓多少？/);
  assert.deepEqual(lastSay().reply_markup.inline_keyboard, [[{ text: '抓 30 首', callback_data: 'hk:30' }, { text: '全部 90 首', callback_data: 'hk:90' }]]);
  await press(OWNER, 'hk:90');
  cnt = bot.toStreamer.at(-1);
  assert.deepEqual([cnt.path, cnt.body.url, cnt.body.settings.limit], ['harvest', 'https://music.163.com/album?id=5', 90]);
  assert.match(lastSay().text, /最多 90 首/);
  assert.equal((await lib.getHarvest()).limit, 30, '按钮的数量只管这一次');
  bot.count = { ...bot.count, kind: 'album', name: '晴天', total: 500, have: 0 };
  await dm(OWNER, 'https://music.163.com/album?id=5');
  assert.match(lastSay().text, /^专辑「晴天」：一共 500 首/);
  assert.deepEqual(lastSay().reply_markup.inline_keyboard[0].map(b => b.text), ['抓 30 首', '抓 200 首（一次最多）']);
  bot.count = { ...bot.count, total: 4, have: 4 };
  await dm(OWNER, 'https://music.163.com/album?id=5');
  assert.match(lastSay().text, /都搬过了/);
  bot.describe = { site: '网易云音乐 music.163.com', kind: 'song', name: '', id: '1' };
  await dm(OWNER, 'https://music.163.com/#/song?id=1');
  assert.equal(bot.toStreamer.at(-1).path, 'harvest', '单曲不用数，直接抓');
  bot.count = bot.describe = null;
  // 爬 关键词：不用网址，去网站上搜着抓
  await dm(OWNER, '爬 小橘 晴天 8');
  const q = bot.toStreamer.at(-1);
  assert.equal(q.path, 'harvest');
  assert.equal(q.body.query, '小橘 晴天');
  assert.equal(q.body.url, undefined);
  assert.deepEqual(q.body.settings, { limit: 8, playlist: '纯音乐', channel: '', sites: ['netease'] });
  assert.match(lastSay().text, /开始在网易云音乐 music.163.com搜「小橘 晴天」，最多 8 首。抓完发审核单给你/);
  await dm(OWNER, '爬小橘');
  assert.equal(bot.toStreamer.at(-1).body.query, '小橘');
  assert.equal(bot.toStreamer.at(-1).body.settings.limit, 30, '没写数量用设置里的');
  const n0 = bot.toStreamer.length;
  await dm(OWNER, '爬');
  assert.equal(bot.toStreamer.length, n0);
  assert.match(lastSay().text, /爬什么？/);
  // 搬来的帖子（说明里有授权、来源）进「纯音乐」，不按类型分
  const caption = 'Gymnopedie No. 1 — Kevin MacLeod\n授权：频道主确认是小橘音乐自己的作品\n来源：https://music.163.com/song?id=11';
  await hook({ channel_post: { ...audioPost(980, { file_id: addFile(bytesOf(10, 980)), file_size: 10, title: 'Gymnopedie No. 1', performer: 'Kevin MacLeod' }), caption } });
  let pl = Object.fromEntries((await lib.listPlaylists()).map(p => [p.name, p.tracks]));
  assert.deepEqual([pl['纯音乐'], pl['华语流行']], [[980], []]);
  await dm(OWNER, '搬运歌单 自动');
  await hook({ channel_post: { ...audioPost(981, { file_id: addFile(bytesOf(10, 981)), file_size: 10, title: 'Piano', performer: 'Someone' }), caption } });
  pl = Object.fromEntries((await lib.listPlaylists()).map(p => [p.name, p.tracks]));
  assert.deepEqual(pl['华语流行'], [], '改回自动后按类型分；分不出类型的搬来的歌不硬塞华语流行');
  await hook({ channel_post: { ...audioPost(982, { file_id: addFile(bytesOf(10, 982)), file_size: 10, title: 'Night Drive (DJ Remix)', performer: 'Someone' }), caption } });
  pl = Object.fromEntries((await lib.listPlaylists()).map(p => [p.name, p.tracks]));
  assert.ok(!pl['华语流行'].includes(982));
  const st = await lib.getHarvest();
  assert.deepEqual(st, { limit: 30, playlist: '', channel: '' });
  for (const id of [980, 981, 982]) await admin('remove', { track: id });
  await admin('playlists', { playlists: [] });
});

await t('贴网址搬运的审核单：按通过 / 失败交给流式服务，审核单改成审过的样子；过期、在忙都说清楚；「查看全部」网页', async () => {
  const sheetText = '🛂 审核单 abcdefghijklmn（网易云音乐 music.163.com，2 首，确认是不是我们的歌）\n网址：https://music.163.com/#/artist?id=9\n\n· 甲 — A\n  https://music.163.com/song?id=1\n\n逐个核对，全是我们自己的歌再点「审核通过」，整批一起；有不是我们的就点「审核失败」，一首都不发。';
  const pressSheet = (from, data) => hook({ update_id: 3, callback_query: { id: 'cb', from: { id: from }, data,
    message: { message_id: 77, chat: { id: from, type: 'private' }, text: sheetText } } });
  const acks = () => bot.out.filter(o => o.method === 'answerCallbackQuery').at(-1).text;
  const lastEdit = () => bot.out.filter(o => o.method === 'editMessageText').at(-1);

  bot.review = { result: 'approved', count: 2 };
  const before = bot.toStreamer.length;
  await pressSheet(FAN, 'hv:ok:abcdefghijklmn');
  assert.equal(bot.toStreamer.length, before, '别人按没用');
  await pressSheet(OWNER, 'hv:ok:abcdefghijklmn');
  const call = bot.toStreamer.at(-1);
  assert.equal(call.path, 'harvest/review');
  assert.deepEqual([call.body.id, call.body.ok, call.body.notify], ['abcdefghijklmn', true, OWNER]);
  assert.ok(Array.isArray(call.body.existing) && call.body.existing.length > 0, '带上库里已有的歌，通过时再查一次重');
  assert.match(acks(), /审核通过：2 首开始发进频道/);
  let e = lastEdit();
  assert.equal(e.message_id, 77);
  assert.ok(e.text.startsWith('🛂 审核单 abcdefghijklmn') && e.text.includes('· 甲 — A'));
  assert.ok(!e.text.includes('逐个核对') && e.text.endsWith('✅ 审核通过：2 首开始发进频道，发完告诉你'));
  assert.equal(e.reply_markup, undefined, '按钮去掉了');
  assert.equal(call.body.channel, '', '默认发正式频道');

  // 测试频道：审核通过的先发去那里
  await dm(OWNER, '搬运频道 @xiaoju_test');
  assert.match(lastSay().text, /先发到测试频道 @xiaoju_test，不进小橘音乐/);
  await dm(OWNER, '搬运设置');
  assert.match(lastSay().text, /发到频道：测试频道 @xiaoju_test/);
  const approved = bot.review;
  bot.review = { ...approved, channel: 'xiaoju_test' };
  await pressSheet(OWNER, 'hv:ok:abcdefghijklmn');
  assert.equal(bot.toStreamer.at(-1).body.channel, 'xiaoju_test');
  assert.match(acks(), /2 首开始发进测试频道 @xiaoju_test/);
  await dm(OWNER, '搬运频道 不合法的 名字');
  assert.match(lastSay().text, /频道名不对/);
  await dm(OWNER, '搬运频道 正式');
  assert.equal((await lib.getHarvest()).channel, '');

  // 网易云登录：流式服务发二维码；扫完它把 cookie 交到 /netease-cookie；审核通过时带上
  await dm(OWNER, '网易云登录');
  assert.deepEqual(bot.toStreamer.at(-1), { path: 'netease/login', body: { notify: OWNER }, query: '' });
  assert.match(lastSay().text, /二维码马上发给你/);
  await dm(OWNER, '搬运设置');
  assert.match(lastSay().text, /网易云账号：没登录/);
  // 扫完码 cookie 留在流式服务那里，Worker 用的时候去取、存下来；流式服务重启（没了）也还用存着的
  bot.netease = { cookie: 'MUSIC_U=secretcookie', nickname: '小橘', at: Date.now() };
  await dm(OWNER, '搬运设置');
  assert.match(lastSay().text, /网易云账号：小橘（\d{4}-\d\d-\d\d 登录/);
  bot.netease = null;
  await dm(OWNER, '搬运设置');
  assert.match(lastSay().text, /网易云账号：小橘/);
  assert.ok(!lastSay().text.includes('secretcookie'));
  await pressSheet(OWNER, 'hv:ok:abcdefghijklmn');
  assert.equal(bot.toStreamer.at(-1).body.cookie, 'MUSIC_U=secretcookie', '审核通过时带上网易云账号');
  bot.review = { result: 'rejected', count: 2 };
  await pressSheet(OWNER, 'hv:no:abcdefghijklmn');
  assert.equal(bot.toStreamer.at(-1).body.cookie, '', '审核失败不带');
  await dm(OWNER, '搬运设置');
  assert.match(lastSay().text, /发到频道：正式频道「小橘🍊音乐」/);
  bot.review = approved;

  bot.review = { result: 'rejected', count: 2 };
  await pressSheet(OWNER, 'hv:no:abcdefghijklmn');
  assert.equal(bot.toStreamer.at(-1).body.ok, false);
  assert.match(lastEdit().text, /❌ 审核失败：2 首不发$/);

  bot.review = { result: 'missing', count: 0 };
  await pressSheet(OWNER, 'hv:ok:abcdefghijklmn');
  assert.match(lastEdit().text, /过期了.*重新发一次网址/);

  const edits = bot.out.filter(o => o.method === 'editMessageText').length;
  bot.review = { result: 'busy', count: 2, busy: '正在把审核通过的 20 首发进频道（已发 5 首，处理到第 6 首）' };
  await pressSheet(OWNER, 'hv:ok:abcdefghijklmn');
  assert.match(acks(), /上一单还没做完：正在把审核通过的 20 首发进频道（已发 5 首/);
  assert.equal(bot.out.filter(o => o.method === 'editMessageText').length, edits, '在忙：审核单不动，等会儿还能再点');

  // 「查看全部」
  let r = await req('/harvest-review/abcdefghijklmn');
  assert.equal(r.status, 404);
  bot.sheet = { id: 'abcdefghijklmn', site: '网易云音乐 music.163.com', url: 'https://music.163.com/#/artist?id=9', status: 'review', tracks: [
    { title: '甲 <b>', artist: 'A', page: 'https://music.163.com/song?id=1' },
    { title: '乙', artist: '', page: 'javascript:alert(1)' },
  ] };
  r = await req('/harvest-review/abcdefghijklmn');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('X-Robots-Tag'), 'noindex');
  const page = await r.text();
  assert.ok(page.includes('甲 &lt;b&gt;') && !page.includes('甲 <b>'), '转义');
  assert.ok(page.includes('href="https://music.163.com/song?id=1"') && !page.includes('href="javascript:'), '只放 http(s) 链接');
  assert.match(page, /2 首，确认是不是我们的歌，待审核/);
  assert.equal((await req('/harvest-review/ABC')).status, 404);
  bot.sheet = { ...bot.sheet, url: '', query: '小橘 <i>' };  // 「爬 关键词」搜来的审核单
  const qpage = await (await req('/harvest-review/abcdefghijklmn')).text();
  assert.ok(qpage.includes('搜：小橘 &lt;i&gt;') && !qpage.includes('网址：'));
  bot.review = bot.sheet = null;
});

await t('夜里自动搬：叫醒流式服务，带上每个频道上次看到哪条；上一晚搬完的记录合进来；还在搬就不再开', async () => {
  await admin('sources', { sources: ['VmoMusic', 'yinyue555'] });
  bot.autoStatus = { status: 'idle' };
  const before = bot.toStreamer.length;
  let r = await jsonOf(await admin('auto-run', {}));
  assert.equal(r.ok, true);
  const altSync = bot.toStreamer.slice(before).find(x => x.path === 'harvest/alts');
  assert.ok(altSync && altSync.body.notify === OWNER && altSync.body.alts.map(a => a.name).join() === '小橘', '夜里也同步小号');
  let b = bot.toStreamer.at(-1);
  assert.equal(b.path, 'auto/start');
  assert.deepEqual(b.body.sources, { VmoMusic: 0, yinyue555: 0 });
  assert.equal(b.body.notify, OWNER);
  // 第二晚：上一晚搬完了，记下每个频道看到的最大消息号
  bot.autoStatus = { status: 'done', run_id: r.runId, copied: 7, sources: { VmoMusic: { max_id: 900, copied: 5 }, yinyue555: { max_id: 50, copied: 2 } } };
  await new Promise(res => setTimeout(res, 1100)); // 换一秒，run_id 才不一样
  r = await jsonOf(await admin('auto-run', {}));
  b = bot.toStreamer.at(-1);
  assert.deepEqual(b.body.sources, { VmoMusic: 900, yinyue555: 50 });
  const st = await jsonOf(await admin('auto-state'));
  assert.equal(st.runId, r.runId);
  bot.autoStatus = { status: 'running' };
  const n = bot.toStreamer.length;
  r = await jsonOf(await admin('auto-run', {}));
  assert.deepEqual([r.ok, r.why], [false, 'still running']);
  assert.equal(bot.toStreamer.at(-1).path, 'auto/status');
  assert.deepEqual(bot.toStreamer.slice(n).map(x => x.path), ['netease/session', 'harvest/alts', 'auto/status'], '来源频道还在搬，小号照样同步');
});

await t('频道主的菜单：常驻按钮和 / 命令（只设给频道主），点了等于发对应的文字；听众看不到', async () => {
  await lib.setConfig('cmdsVer', '');
  await dm(OWNER, '/start');
  const set = bot.out.filter(o => o.method === 'setMyCommands').at(-1);
  assert.deepEqual(set.scope, { type: 'chat', chat_id: OWNER });
  assert.ok(set.commands.some(c => c.command === 'stats'));
  assert.ok(!set.commands.some(c => c.command === 'progress'), '菜单里没有抖音的命令');
  const help = lastSay();
  assert.match(help.text, /🎵 音乐/);
  assert.doesNotMatch(help.text, /运行爬虫|搜抖音|审核/);
  assert.deepEqual(help.reply_markup.keyboard[0], ['📈 统计', '⏳ 进度']);
  assert.ok(set.commands.some(c => c.command === 'tasks'));
  // 版本变了：重设菜单，再发一句带新按钮的话（常驻按钮要随消息发过去才会换）
  const news = bot.out.filter(o => o.method === 'sendMessage' && /按钮更新了/.test(o.text)).at(-1);
  assert.equal(news.chat_id, OWNER);
  assert.deepEqual(news.reply_markup.keyboard.flat(),
    ['📈 统计', '⏳ 进度', '👥 小号', '🔄 同步小号', '⬜ 灰色歌', '🩺 自检', '🔑 网易云登录', '🎵 搬运设置', '❓ 帮助']);
  assert.deepEqual(set.commands.map(c => c.command), ['stats', 'tasks', 'alts', 'sync', 'grey', 'check', 'login', 'harvest', 'help']);
  assert.ok(set.commands.every(c => c.command.length <= 32 && c.description.length <= 256), 'Telegram 的长度限制');
  // 每个按钮、每个 / 命令都对得上一个真的命令（不会落到「找歌」去）
  for (const [b, cmd] of [['🔄 同步小号', '/sync'], ['⬜ 灰色歌', '/grey'], ['🩺 自检', '/check'], ['🔑 网易云登录', '/login']]) {
    for (const x of [b, cmd]) {
      const before = bot.toStreamer.length + bot.out.length;
      await dm(OWNER, x);
      assert.ok(bot.toStreamer.length + bot.out.length > before, x + ' 有回应');
      assert.doesNotMatch(lastSay() ? lastSay().text : '', /没找到|找不到「/, x + ' 不是当成歌名去找');
    }
  }
  const n = bot.out.filter(o => o.method === 'setMyCommands').length;
  await dm(OWNER, '❓ 帮助');
  assert.equal(bot.out.filter(o => o.method === 'setMyCommands').length, n, '设过一次就不再设');
  assert.match(lastSay().text, /全部功能/);
  await dm(OWNER, '📈 统计');
  assert.match(lastSay().text, /歌库一共/);
  await dm(OWNER, '/tasks');
  assert.match(lastSay().text, /没有在搬的活|正在|上一单/);
  await dm(OWNER, '/harvest@xiaoju_music_bot');
  assert.match(lastSay().text, /搬运设置/);
  await dm(FAN + 6, '/start');
  assert.ok(!lastSay().reply_markup, '听众没有频道主的按钮');
});

await t('封面、歌词补全：没自带封面先用网易云的专辑封面（搬来的按编号认，别的要歌名歌手时长对上）；「补封面」「补歌词」', async () => {
  neteaseDb.push(
    { id: 901, name: '橘子汽水', ar: [{ name: '小橘' }], dt: 200000, al: { picUrl: 'http://p1.music.126.net/x/orange.jpg' } },
    { id: 902, name: '橘子汽水', ar: [{ name: '小橘' }], dt: 260000, al: { picUrl: 'http://p1.music.126.net/x/live.jpg' } },
    { id: 903, name: '同名歌', ar: [{ name: '别人' }], dt: 200000, al: { picUrl: 'http://p1.music.126.net/x/other.jpg' } },
  );
  neteaseLyrics.set(902, lrcOf(['现场版一', '现场版二', '现场版三', '现场版四', '现场版五']));
  const noThumb = (id, extra) => audioPost(id, { file_id: addFile(bytesOf(10, id)), file_size: 10, ...extra });
  // 时长对得上：用网易云的专辑封面，算自带的（?art=1 也给）
  await hook({ channel_post: noThumb(921, { title: '橘子汽水', performer: '小橘', duration: 201 }) });
  let r = await req('/c/921?art=1');
  assert.equal(r.status, 200);
  assert.equal(await textOf(r), 'ALBUM:orange.jpg');
  // 搬来的（说明里有网易云编号）：就认这一首，时长不比
  const caption = '橘子汽水 — 小橘\n授权：频道主确认是小橘音乐自己的作品\n来源：https://music.163.com/song?id=902';
  await hook({ channel_post: { ...noThumb(922, { title: '橘子汽水', performer: '小橘', duration: 100 }), caption } });
  assert.equal(await textOf(await req('/c/922?art=1')), 'ALBUM:live.jpg');
  assert.match((await jsonOf(await req('/l/922'))).lines.map(l => l[1]).join(), /现场版一/, '歌词也按编号取');
  // 歌手对不上：不用网易云的图（退回频道图片，?art=1 没有）
  await hook({ channel_post: noThumb(923, { title: '同名歌', performer: '小橘', duration: 200 }) });
  assert.equal((await req('/c/923?art=1')).status, 404);
  // 补封面：用着频道图片的、记成没有的清掉，下次重新找；网易云的专辑封面不动
  await dm(OWNER, '补封面');
  assert.match(lastSay().text, /^好的，\d+ 首没有专辑封面的歌/);
  assert.ok(await lib.getCover(921), '网易云的专辑封面算自带的，不清');
  assert.equal(await lib.getCover(923), null);
  await lib.putLyrics(923, 'none', '', Date.now() + 1e9);
  await dm(OWNER, '补歌词');
  assert.match(lastSay().text, /^好的，\d+ 首没歌词或只有文字的歌/);
  assert.equal((await lib.getLyrics(923)).retry_at, 1);
  // 后台补全：每分钟的定时任务把还没找过的封面、歌词先找好存起来，不用等人打开
  await hook({ channel_post: noThumb(924, { title: '柠檬水', performer: '小橘', duration: 150 }) });
  assert.equal(await lib.getCover(924), null);
  assert.equal(await lib.getLyrics(924), null);
  const runs = [];
  const tick = async cron => { await worker.scheduled({ cron }, env, { waitUntil: p => runs.push(p) }); await Promise.all(runs.splice(0)); };
  for (let i = 0; i < 40 && (!(await lib.getCover(924)) || !(await lib.getLyrics(924))); i++) await tick('*/5 * * * *');
  assert.ok(await lib.getCover(924), '封面后台找好了');
  assert.ok(await lib.getLyrics(924), '歌词后台找好了');
  await lib.setConfig('fillCursor', '923');
  assert.equal((await lib.missingArt(50, Date.now())).covers.includes(924), false);
  await dm(OWNER, '统计');
  assert.match(lastSay().text, /封面：专辑图 \d+ 首，频道图片 \d+ 首，没有 \d+ 首/);
  assert.match(lastSay().text, /歌词：带时间轴 \d+ 首，只有文字 \d+ 首，没有 \d+ 首/);
  for (const id of [921, 922, 923, 924]) await admin('remove', { track: id });
});

await t('歌手页按网易云热门 50 首排：后台取歌手的热门歌，/api/tracks 带上排好的消息号', async () => {
  const lib = env.LIB.get(env.LIB.idFromName('library'));
  const noThumb = (id, extra) => audioPost(id, { file_id: addFile(bytesOf(10, id)), file_size: 10, ...extra });
  // 新的在前：冷门歌是最新发的，热门歌是老帖
  await hook({ channel_post: noThumb(931, { title: '热门第二', performer: '星火乐队', duration: 200 }) });
  await hook({ channel_post: noThumb(932, { title: '热门第一 (Live)', performer: '星火乐队', duration: 200 }) });
  await hook({ channel_post: noThumb(933, { title: '热门第一', performer: '星火乐队&路人甲', duration: 201 }) });
  await hook({ channel_post: noThumb(934, { title: '冷门歌', performer: '星火乐队', duration: 200 }) });
  neteaseArtists.push({ id: 31, name: '星火乐队', hot: ['热门第一', '没搬的歌', '热门第二'] },
    { id: 32, name: '星火乐队二队', hot: ['冷门歌'] });  // 名字像但不是同一位：不能算
  const runs = [];
  const tick = async () => { await worker.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: p => runs.push(p) }); await Promise.all(runs.splice(0)); };
  lib.changed();  // 像 DO 刚醒：歌表不在内存里
  assert.deepEqual(await lib.missingHot(5, Date.now()), [], '歌表不在内存里（DO 刚醒）：不为取热门歌去读整张歌表');
  // 有人打开网页（歌表进了内存）之后，定时任务才顺带补
  for (let i = 0; i < 60 && !(await lib.listHot()).songs['星火乐队']; i++) { await lib.listTracks(); await tick(); }
  const { songs: hot, pics } = await lib.listHot();
  assert.equal(pics['星火乐队'], 'https://p1.music.126.net/art31.jpg', '顺带记下歌手照片（换成 https）');
  assert.deepEqual(hot['星火乐队'], ['热门第一', '没搬的歌', '热门第二'], '后台取到了热门歌');
  assert.equal(hot['路人甲'], undefined, '网易云上没有的歌手不给');
  for (let i = 0; i < 60 && (await lib.listTracks(), (await lib.missingHot(5, Date.now())).length); i++) await tick();
  await lib.listTracks();
  assert.deepEqual(await lib.missingHot(5, Date.now()), [], '都取过了，一周内不再取');
  const d = await jsonOf(await req('/api/tracks'));
  assert.deepEqual(d.hot['星火乐队'], [933, 932, 931], '按热门的顺序；同一首原版在 Live 前面；冷门歌不在里面（网页排在热门后面）');
  assert.equal(d.hot['路人甲'], undefined);
  assert.equal(d.pics['星火乐队'], 'https://p1.music.126.net/art31.jpg');
  // 重取时没拿到照片：留着原来的
  await lib.putHot('星火乐队', ['热门第一'], Date.now() + DAY, '');
  assert.equal((await lib.listHot()).pics['星火乐队'], 'https://p1.music.126.net/art31.jpg');
  for (const id of [931, 932, 933, 934]) await admin('remove', { track: id });
});

await t('发歌、删歌、配封面只重读那一首：内存里的歌表和整表重读一模一样', async () => {
  await lib.listTracks();  // 有人打开过网页：歌表在内存里
  await hook({ channel_post: audioPost(941, { file_id: addFile(bytesOf(10, 941)), file_size: 10, title: '中间插进来', performer: '甲', duration: 100 }) });
  await hook({ channel_post: audioPost(942, { file_id: addFile(bytesOf(10, 942)), file_size: 10, title: '最新的', performer: '乙', duration: 100 }) });
  await lib.putCover(941, 'image/jpeg', 'QUJD', 1);
  await admin('remove', { track: 942 });
  const patched = JSON.stringify(await lib.listTracks());
  lib.changed();
  assert.equal(patched, JSON.stringify(await lib.listTracks()), '顺序、封面标记都和重读的一样');
  assert.ok((await lib.listTracks()).some(x => x.id === 941 && x.art === 1));
  await admin('remove', { track: 941 });
});

await t('数据库休眠后醒来：歌表、热门歌、频道图片、灰色歌从 memo 的桶里读回来（几行），不再把原表整张读一遍，内容一模一样', async () => {
  await hook({ channel_post: audioPost(945, { file_id: addFile(bytesOf(10, 945)), file_size: 10, title: '醒来测试', performer: '小橘', duration: 100 }) });
  await lib.putCover(945, 'image/jpeg', 'QUJD', 1);
  await lib.putHot('小橘', ['醒来测试'], Date.now() + DAY, 'https://p1.music.126.net/a.jpg');
  const before = { tracks: await lib.listTracks(), recs: await lib.listRecs(), hot: await lib.listHot(), photos: await lib.listPhotos(), grey: await lib.listGrey() };
  const woke = await makeLibrary(env, lib._db);  // 同一份数据，新的 DO 实例（内存是空的）
  const from = sqlLog.length;
  const after = { tracks: await woke.listTracks(), recs: await woke.listRecs(), hot: await woke.listHot(), photos: await woke.listPhotos(), grey: await woke.listGrey() };
  assert.deepEqual(after, before);
  const reads = sqlLog.slice(from).filter(q => /^\s*SELECT/i.test(q));
  assert.ok(!reads.some(q => /FROM (songs|artist_hot|photos|grey)\b/.test(q)), '不读原表：' + reads.join(' / '));
  // 醒着的时候改一首：只重写它那一桶，再醒来也是新的
  await woke.putCover(945, 'none', '', 0);
  const woke2 = await makeLibrary(env, lib._db);
  assert.equal((await woke2.listTracks()).find(x => x.id === 945).art, 0);
  // 格式版本对不上（MEMO_V 改了）：作废重建，照样对
  lib._db.prepare("UPDATE memo SET v = 'old' WHERE k = 'tracks|v'").run();
  const woke3 = await makeLibrary(env, lib._db);
  assert.deepEqual((await woke3.listTracks()).map(x => [x.id, x.art]), (await woke2.listTracks()).map(x => [x.id, x.art]));
  await admin('remove', { track: 945 });
});

await t('数据库挂了（额度用完）：网页从 KV 快照照样能打开、能听；机器人说一声，不再不吭声', async () => {
  await hook({ channel_post: audioPost(951, { file_id: addFile(bytesOf(30, 951)), file_size: 30, title: '挂了也能听', performer: '小橘', duration: 100 }) });
  const runs = [];
  const tick = async at => { await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: at }, env, { waitUntil: p => runs.push(p) }); await Promise.all(runs.splice(0)); };
  await tick(Date.UTC(2026, 0, 1, 3, 25));
  assert.ok(!String(await env.TRACKS.get('snapshot:tracks')).includes('挂了也能听'), '不是整点那一轮：不写 KV（免费版每天只能写 1000 次）');
  await tick(Date.UTC(2026, 0, 1, 4, 0));
  const snap = JSON.parse(await env.TRACKS.get('snapshot:tracks'));
  assert.ok(snap.tracks.some(x => x.id === 951) && !JSON.stringify(snap.tracks).includes('file_id'), '快照里的歌单和 /api/tracks 一样，不带 file_id');
  assert.equal((await env.TRACKS.get('snapshot:recs', 'json'))[951].size, 30);
  await admin('remove', { track: 999999 });  // 让 isolate 里的歌单缓存作废
  const realLib = env.LIB;
  env.LIB = { idFromName: n => n, get: () => new Proxy({}, { get: () => async () => { throw new Error('Exceeded allowed rows read in Durable Objects free tier.'); } }) };
  try {
    const r = await req('/api/tracks');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('X-Degraded'), '1');
    assert.ok((await jsonOf(r)).tracks.some(x => x.id === 951));
    const a = await req('/a/951', { headers: { Range: 'bytes=0-9' } });
    assert.equal(a.status, 206, '用快照里的文件信息照样放');
    assert.equal((await a.arrayBuffer()).byteLength, 10);
    const c = await req('/c/951');
    assert.equal(c.status, 500, '封面不进快照：网页画文字封面');
    assert.match(await textOf(c), /（Error: Exceeded allowed rows read/, '500 里带上报错原文，不开日志也知道原因');
    bot.out.length = 0;
    await dm(FAN, '晴天');
    assert.match(lastSay().text, /数据库今天的免费额度用完了/);
    await press(OWNER, 'a:951');
    assert.ok(bot.out.some(o => o.method === 'answerCallbackQuery'), '按钮也回一声，不转圈');
    assert.match(lastSay().text, /网页还能听歌/);
  } finally {
    env.LIB = realLib;
  }
  await admin('remove', { track: 951 });
});

await t('灰色歌：网易云上没有音源的只记信息，网页上灰色显示，清单 txt 发给频道主', async () => {
  await hook({ channel_post: audioPost(961, { file_id: addFile(bytesOf(10, 961)), file_size: 10, title: '后来有了', performer: '孙燕姿', duration: 200 }) });
  bot.out.length = 0;
  await dm(OWNER, '灰色歌');
  assert.match(lastSay().text, /还没有灰色歌/);
  bot.grey = [
    { sid: '11', title: '天黑黑', artist: '孙燕姿', album: 'My Story 2006', year: '2007', duration: 234, pop: 100, why: '网易云没版权', page: 'https://music.163.com/song?id=11', at: 1 },
    { sid: '12', title: '后来有了', artist: '孙燕姿', album: '', year: '', duration: 0, pop: 50, why: '要单独购买专辑', page: '', at: 1 },
    { sid: '13', title: '第一天', artist: '孙燕姿', album: '', year: '2004', duration: 200, pop: 80, why: '网易云没版权', page: 'javascript:alert(1)', at: 1 },
    { sid: 'x', title: '坏数据' }, { sid: '14', title: '', artist: '甲' },
  ];
  // 每小时整点那一轮去流式服务取：有新的就把清单发给频道主
  const runs = [];
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.UTC(2026, 0, 1, 5, 0) }, env, { waitUntil: p => runs.push(p) });
  await Promise.all(runs.splice(0));
  const doc = bot.out.filter(o => o.method === 'sendDocument').at(-1);
  assert.equal(String(doc.chat_id), String(OWNER));
  assert.equal(doc.name, '小橘音乐-灰色歌.txt');
  assert.match(doc.caption, /共 2 首，1 位歌手，.* 更新，新增 3 首/);
  assert.match(doc.text, /共 2 首，1 位歌手/, '已经搬进来的（后来有了）不算灰色');
  assert.match(doc.text, /【孙燕姿】2 首\n  天黑黑 — 《My Story 2006》 · 2007 · 3:54 · 网易云没版权 · 热度 100\n    https:\/\/music\.163\.com\/song\?id=11\n  第一天 — 2004 · 3:20 · 网易云没版权 · 热度 80\n$/);
  assert.doesNotMatch(doc.text, /javascript|坏数据/);
  const pin = bot.out.find(o => o.method === 'pinChatMessage');
  const fileMsg = JSON.parse(await lib.getConfig('greyMsg')).id;
  assert.equal(pin.message_id, fileMsg, '清单置顶');
  const d = await jsonOf(await req('/api/tracks'));
  assert.deepEqual(d.grey.map(g => g.sid).sort(), ['11', '13']);
  assert.deepEqual(Object.keys(d.grey[0]).sort(), ['album', 'artist', 'duration', 'sid', 'title', 'why', 'year']);
  const tick = async h => { await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.UTC(2026, 0, 1, h, 0) }, env, { waitUntil: p => runs.push(p) }); await Promise.all(runs.splice(0)); };
  // 再取一次：没有新的，什么也不发
  const n = bot.out.length;
  await tick(6);
  assert.equal(bot.out.length, n);
  // 有新的：替换置顶那条里的文件（不发新文件），另发一句短提示
  bot.grey.push({ sid: '15', title: '遇见', artist: '孙燕姿', why: '网易云没版权', pop: 99 });
  await tick(7);
  assert.equal(bot.out.filter(o => o.method === 'sendDocument').length, 1, '只有一个文件');
  const edit = bot.out.filter(o => o.method === 'editMessageMedia').at(-1);
  assert.equal(edit.message_id, fileMsg);
  assert.match(edit.caption, /共 3 首，1 位歌手，.*新增 1 首/);
  assert.match(edit.text, /遇见/);
  assert.match(lastSay().text, /灰色歌清单更新了：新增 1 首，现在共 3 首/);
  assert.equal(lastSay().reply_parameters.message_id, fileMsg, '点提示就跳到那个文件');
  // 频道主自己要：也是更新那一个，告诉他在置顶
  await dm(OWNER, '灰色歌');
  assert.equal(bot.out.filter(o => o.method === 'sendDocument').length, 1);
  assert.match(lastSay().text, /就是置顶的那个文件/);
  // 那条被删了：重发一条、重新置顶
  bot.deletedMsgs = [fileMsg];
  bot.grey.push({ sid: '16', title: '开始懂了', artist: '孙燕姿', why: '要单独购买专辑' });
  await tick(8);
  const again = bot.out.filter(o => o.method === 'sendDocument');
  assert.equal(again.length, 2);
  assert.match(again.at(-1).text, /开始懂了/);
  assert.notEqual(JSON.parse(await lib.getConfig('greyMsg')).id, fileMsg);
  assert.equal(bot.out.filter(o => o.method === 'pinChatMessage').length, 2);
  bot.deletedMsgs = null;
  bot.grey = [];
  await admin('remove', { track: 961 });
});

await t('贴网易云歌单：照着建一个同名歌单（封面、简介、顺序），库里有的放进去，没有的在歌单里灰色，再贴一次就更新', async () => {
  await hook({ channel_post: audioPost(971, { file_id: addFile(bytesOf(10, 971)), file_size: 10, title: '晴天', performer: '周杰伦', duration: 269 }) });
  await hook({ channel_post: audioPost(972, { file_id: addFile(bytesOf(10, 972)), file_size: 10, title: '稻香', performer: '周杰伦', duration: 223 }) });
  bot.describe = { site: '网易云音乐 music.163.com', kind: 'playlist', name: '小橘的夜', id: '7' };
  bot.count = { site: '网易云音乐 music.163.com', kind: 'playlist', name: '小橘的夜', total: 3, have: 2 };
  bot.playlist = { id: '7', name: '小橘的夜', cover: 'https://p1.music.126.net/c.jpg', intro: '睡前听',
    songs: [{ sid: '3', title: '稻香', artist: '周杰伦', duration: 223 }, { sid: '9', title: '没有的歌', artist: '别人', duration: 200 },
            { sid: '1', title: '晴天', artist: '周杰伦', duration: 269 }, { sid: 'x', title: '坏数据' }] };
  await dm(OWNER, 'https://music.163.com/#/playlist?id=7');
  const pl = bot.toStreamer.filter(x => x.path === 'harvest/playlist').at(-1);
  assert.equal(pl.body.url, 'https://music.163.com/#/playlist?id=7');
  assert.equal(typeof pl.body.cookie, 'string', '带上网易云账号，私密歌单也取得到');
  const said = bot.out.filter(o => o.method === 'sendMessage').slice(-2).map(o => o.text);
  assert.match(said[0], /建好歌单「小橘的夜」：一共 3 首，小橘音乐里已有的 2 首已经按网易云的顺序放进去了。还没有的 1 首马上出审核单给你，通过后发进频道，就会出现在歌单里/);
  // 库里没有的直接出审核单（不再先数一数、等按按钮）：带上登录的账号（私密歌单），整个歌单都看
  const hv = bot.toStreamer.filter(x => x.path === 'harvest').at(-1);
  assert.deepEqual([hv.body.url, hv.body.settings.limit, hv.body.settings.scan, typeof hv.body.cookie], ['https://music.163.com/#/playlist?id=7', 1, 3, 'string']);
  assert.ok(!bot.toStreamer.some(x => x.path === 'harvest/count' && x.body.url === hv.body.url), '不再先数一数');
  assert.match(said[1], /开始从网易云音乐 music\.163\.com抓，最多 1 首。抓完发审核单给你/);
  let d = await jsonOf(await req('/api/tracks'));
  const p = d.playlists[0];
  assert.deepEqual([p.name, p.pic, p.intro, p.tracks], ['小橘的夜', 'https://p1.music.126.net/c.jpg', '睡前听', [972, -9, 971]], '新建的排最前，按网易云的顺序');
  assert.deepEqual(d.grey.find(g => g.sid === '9'), { sid: '9', title: '没有的歌', artist: '别人', album: '', year: '', duration: 200, why: '待搬：审核通过后就能听', pl: 1 });
  assert.ok(!('wanted' in p) && !('src' in p), '网页不用的不给');
  // 后来搬进来了：自动出现在歌单里对应的位置
  await hook({ channel_post: audioPost(973, { file_id: addFile(bytesOf(10, 973)), file_size: 10, title: '没有的歌', performer: '别人', duration: 200 }) });
  d = await jsonOf(await req('/api/tracks'));
  assert.deepEqual(d.playlists[0].tracks, [972, 973, 971]);
  assert.ok(!d.grey.some(g => g.sid === '9'));
  // 网易云那边改了，再贴一次：更新同一个歌单，不另建
  bot.playlist = { ...bot.playlist, name: '小橘的夜（新）', songs: [{ sid: '1', title: '晴天', artist: '周杰伦', duration: 269 }] };
  const n = d.playlists.length;
  await dm(OWNER, 'https://music.163.com/playlist?id=7');
  assert.match(lastSay().text, /更新了歌单「小橘的夜（新）」：一共 1 首，小橘音乐里已有的 1 首已经按网易云的顺序放进去了，都齐了/, '都有了就不出审核单');
  d = await jsonOf(await req('/api/tracks'));
  assert.equal(d.playlists.length, n);
  assert.deepEqual([d.playlists[0].name, d.playlists[0].tracks], ['小橘的夜（新）', [971]]);
  await dm(OWNER, '统计');
  assert.match(lastSay().text, /· 小橘的夜（新） 1 首（照着网易云歌单）/);
  // 歌单没取到（流式服务旧版、网易云抽风）：照旧数一数、按按钮再抓
  bot.playlist = null;
  bot.count = { site: '网易云音乐 music.163.com', kind: 'playlist', name: '别的', total: 5, have: 1 };
  await dm(OWNER, 'https://music.163.com/playlist?id=8');
  assert.match(lastSay().text, /歌单「别的」：一共 5 首.*没搬的 4 首/);
  bot.describe = null; bot.count = null;
  for (const id of [971, 972, 973]) await admin('remove', { track: id });
});

await t('路由：404、405、CORS 预检', async () => {
  assert.equal((await req('/a/999')).status, 404);
  assert.equal((await req('/a/abc')).status, 404);
  assert.equal((await req('/nope')).status, 404);
  assert.equal((await req('/tg-webhook')).status, 405);
  assert.equal((await req('/a/9', { method: 'POST' })).status, 405);
  assert.equal((await admin('nope', {})).status, 404);
  const r = await req('/a/9', { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /Range/);
});

await t('播放页和管理页都能取到，内嵌脚本能通过语法检查', async () => {
  for (const path of ['/', '/admin']) {
    const r = await req(path);
    assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
    const html = await textOf(r);
    new Function(html.split('<script>')[1].split('</script>')[0]); // 语法错误会抛
  }
  assert.equal((await req('/admin')).headers.get('X-Robots-Tag'), 'noindex');
});

await t('任何响应里都不出现机器人 token、管理密钥、流式服务密钥', async () => {
  assert.ok(seen.length > 20);
  for (const s of seen) {
    for (const secret of [TOKEN, 'SECRET-BOT', ADMIN, SKEY]) assert.ok(!s.includes(secret), 'leaked: ' + s.slice(0, 200));
  }
});

console.log(`\n全部 ${n} 项通过`);
