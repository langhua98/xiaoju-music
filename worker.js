// 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）
//
// 音频文件存在 Telegram 频道里，但网页没法直接播放 Telegram 的音乐文件。这个 Worker 在服务端
// 持有机器人 token，把「频道消息号」换成浏览器能直接播放的地址。
//
// 超过 20 MB 的文件：官方 Bot API 的 getFile 只能取 20 MB 以内的文件，这些文件转给 Hugging Face
// 上的流式服务（streamer/）。它以机器人身份走 MTProto（不受 20 MB 限制），浏览器要哪一段，就从
// Telegram 现取哪一段、边取边传。免费 Space 闲置会休眠：这时第一次请求会把它叫醒，Worker 先回 503，
// 播放页等它醒了自动重试。
//
//   GET  /                 播放页（page.html）
//   GET  /api/tracks       歌单 JSON（新的在前）
//   GET  /a/<消息号>        音频流，支持 Range（iOS Safari 开始播放、拖进度条都要 206）；?dl=1 变成下载
//   GET  /c/<消息号>        封面：音乐文件自带的缩略图；没有就从频道的图片帖里随机挑一张，挑定后存进数据库
//   GET  /l/<消息号>        歌词 JSON：先看数据库；没有就去 LRCLIB、网易云找，找到（或确定没有）就存起来
//   POST /tg-webhook       Telegram 推送频道新帖，音频自动登记；回复某首歌发的 .lrc 文件就是这首的歌词
//   GET  /harvest-review/<编号>  贴网址搬运的审核单「查看全部」：抓到的、等频道主确认是不是我们的歌的每一首（编号随机 14 位）
//   GET  /admin            管理页（admin.html，管理密钥登录）：把频道里已删掉的帖子从歌单移除
//   *    /admin/api/...    管理接口（Authorization: Bearer <ADMIN_KEY>）
//
// 数据在 Durable Object「Library」的 SQLite 里：强一致，也没有 KV list 每天 1000 次的限制。
//
// 绑定：LIB（Durable Object）、TRACKS（旧 KV，只在第一次启动时迁移数据用）、
//       TG_BOT_TOKEN / TG_WEBHOOK_SECRET / ADMIN_KEY / STREAMER_KEY（secret）、
//       CHANNEL_ID / CHANNEL_USERNAME / STREAMER_URL（普通变量；STREAMER_URL 为空则大文件不能播放）
//

import { DurableObject } from 'cloudflare:workers';
import PAGE from './page.html';
import ADMIN_PAGE from './admin.html';

const TG = 'https://api.telegram.org';
// 官方 Bot API 的 getFile 只能取 20 MB 以内的文件，更大的走流式服务
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// getFile 给的下载路径保证至少 1 小时有效，留 10 分钟余量
const PATH_TTL_MS = 50 * 60 * 1000;
const LIST_TTL_MS = 20 * 1000;
const REC_TTL_MS = 60 * 1000;
// 等流式服务回响应头的时间；等不到多半是它在休眠，先让播放页过会儿再试
const STREAMER_WAIT_MS = 25 * 1000;
// 机器人问流式服务（搜歌、开始搬）最多等多久
const BOT_WAIT_MS = 25 * 1000;
// 算音柱数据要先把整首歌从 Telegram 取下来再解码，大文件要久一点
const VIZ_WAIT_MS = 90 * 1000;
// Telegram 给音乐文件生成的缩略图一般 20 KB 上下，超过这个大小就不当封面存
const COVER_LIMIT = 512 * 1024;
// 同一张图被这么多首歌当封面，就当它是别的频道的台标
const LOGO_MIN_SONGS = 8;

// 歌词：LRCLIB 是公开的歌词库（本来就给播放器用）；网易云用的是它网页版的接口，不是公开 API，随时可能变
const LRCLIB = 'https://lrclib.net/api/search';
const NETEASE = 'https://music.163.com/api';
const UA = 'xiaoju-music (https://xiaoju-music.langhua98.workers.dev)';
// 外面那首歌的时长和我们这首相差几秒以内，才认为时间轴对得上
const LYRICS_SLACK_S = 3;
const LYRICS_WAIT_MS = 8000;
const DAY_MS = 24 * 3600 * 1000;
const ASK_PER_DAY = 10;
// 手动发的 .lrc 文件大小上限（一首歌的歌词一般几 KB）
const LRC_LIMIT = 256 * 1024;

const MSG = {
  unavailable: 'Telegram 暂时取不到这个文件，请稍后再试',
  waking: '大文件服务正在唤醒，大约 1 分钟后再试',
  noStreamer: '这首超过 20 MB，暂时不能在网页播放',
  gone: '频道里找不到这首了',
  botDown: '⚠️ 出错了，多半是数据库今天的免费额度用完了（北京时间早上 8 点恢复）。网页还能听歌；搬歌、改歌单、求歌等恢复了再发一次。',
};


const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm',
};

// 三个缓存都只活在单个 isolate 里，丢了无妨，只是省几次 getFile / Durable Object 调用
const filePaths = new Map(); // file_id -> { path, exp }
const recCache = new Map();  // 消息号 -> { rec, exp }
let listCache = null;        // { body, exp }

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export default {
  // 每天北京时间凌晨 3 点（UTC 19:00）：自动去来源频道搬新歌
  async scheduled(controller, env, ctx) {
    // 每分钟一次：后台补封面、歌词；每天一次（北京时间凌晨 3 点）：夜里自动搬
    if (controller.cron === FILL_CRON) {
      // 结果打进 Worker 日志（wrangler tail / 控制台能看），不含 cookie
      ctx.waitUntil(fillMissing(env).then(r => console.log('fill', JSON.stringify(r)), e => console.log('fill failed', String(e))));
      // 每小时（整点那一轮）给 KV 存一份快照，数据库挂了时网页靠它照样能听
      if (new Date(controller.scheduledTime || Date.now()).getUTCMinutes() < 5) {
        ctx.waitUntil(saveSnapshot(env).then(ok => console.log('snapshot', ok), e => console.log('snapshot failed', String(e))));
        ctx.waitUntil(pullGrey(env).then(n => console.log('grey', n), e => console.log('grey failed', String(e))));
      }
      ctx.waitUntil(selfCheck(env, false).then(h => console.log('self-check', JSON.stringify({ at: h.at, login: h.login, songs: h.songs, channel: h.channel, error: h.error })),
        e => console.log('self-check failed', String(e))));
    }
    else ctx.waitUntil(nightly(env).catch(() => {}));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors({ 'Access-Control-Max-Age': '86400' }) });
      }
      if (path === '/tg-webhook') {
        return method === 'POST' ? await webhook(request, env, ctx) : text('Method Not Allowed', 405);
      }
      if (path.startsWith('/admin/api/')) return await adminApi(request, env, url);
      if (method !== 'GET' && method !== 'HEAD') return text('Method Not Allowed', 405);
      if (path === '/') return html(PAGE, method);
      if (path === '/admin') return html(ADMIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      if (path === '/api/tracks') return await trackList(env);
      const m = path.match(/^\/a\/(\d{1,10})(?:\.[a-z0-9]{1,5})?$/i);
      if (m) return await audio(request, env, Number(m[1]), url.searchParams.has('dl'));
      const c = path.match(/^\/c\/(\d{1,10})$/);
      if (c) return await cover(env, Number(c[1]), url.searchParams.get('art') === '1');
      const v = path.match(/^\/v\/(\d{1,10})$/);
      if (v) return await viz(env, Number(v[1]));
      const l = path.match(/^\/l\/(\d{1,10})$/);
      if (l) return await lyrics(env, Number(l[1]));
      const hr = path.match(/^\/harvest-review\/([a-z0-9]{14})$/);
      if (hr) return await harvestReviewPage(env, hr[1], method);
      return text('Not Found', 404);
    } catch (e) {
      if (e instanceof HttpError) return text(e.message, e.status, e.headers);
      // 真正的原因打进 Worker 日志（wrangler tail / 控制台能看），比如免费版 Durable Object 额度用完
      console.log('error', method, path, String((e && e.stack) || e));
      return text('服务器出错了，请稍后再试' + errorWhy(e, env), 500);
    }
  },
};


// 没预料到的错：把错误类型和说明带在 500 里（这个 Worker 没开日志保存，线上出事时不用等 wrangler tail 也能看出原因）。
// 说明里可能带地址：密钥（机器人 token、各种 key）一律换成 ***，Telegram 的 bot<token> 也抹掉
function errorWhy(e, env) {
  let msg = `${(e && e.name) || 'Error'}: ${String((e && e.message) || e)}`;
  for (const k of ['TG_BOT_TOKEN', 'TG_WEBHOOK_SECRET', 'ADMIN_KEY', 'STREAMER_KEY']) {
    if (env && env[k]) msg = msg.split(env[k]).join('***');
  }
  msg = msg.replace(/bot\d+:[\w-]+/g, 'bot***').replace(/\s+/g, ' ').slice(0, 200);
  return `（${(e && e.remote) ? '数据库：' : ''}${msg}）`;
}

function lib(env) {
  return env.LIB.get(env.LIB.idFromName('library'), { locationHint: 'apac' });
}

function streamerOn(env) {
  return !!(env.STREAMER_URL && env.STREAMER_KEY);
}

function streamerBase(env) {
  return env.STREAMER_URL.replace(/\/+$/, '');
}

// 机器人处理到一半出错（多半是数据库今天的额度用完了）：别一声不吭，告诉对方一声。只用 Bot API，不碰数据库
async function botDown(env, update, e) {
  console.log('bot error', String((e && e.stack) || e));
  const cb = update.callback_query;
  const chat = update.message ? update.message.chat.id : cb && cb.message && cb.message.chat.id;
  try {
    if (cb) await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '' });
    if (chat) await say(env, chat, MSG.botDown);
  } catch {
    // Telegram 也不通：算了
  }
}

// ── Telegram webhook：登记频道里的音频 ──────────────────────────────

async function webhook(request, env, ctx) {
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TG_WEBHOOK_SECRET || !sameString(got, env.TG_WEBHOOK_SECRET)) return text('Forbidden', 403);

  const update = await request.json().catch(() => null);
  // 私聊机器人（频道主管理、听众求歌）和按按钮：先回 200，慢慢处理（搜歌要好几秒，Telegram 等不了太久会重发）
  if (update && ((update.message && update.message.chat && update.message.chat.type === 'private') || update.callback_query)) {
    const work = botUpdate(env, update, new URL(request.url).origin).catch(e => botDown(env, update, e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
    return text('ok');
  }
  const post = update && (update.channel_post || update.edited_channel_post);
  // 只收自己频道的帖子；别的群、私聊一律忽略，但仍回 200，免得 Telegram 反复重发
  if (!post || !Number.isInteger(post.message_id) || String(post.chat && post.chat.id) !== String(env.CHANNEL_ID)) {
    return text('ok');
  }
  // .lrc 文件：手动给某首歌配歌词。出了错也回 200，免得 Telegram 反复重发、把后面的新歌堵住
  if (post.document && /\.lrc$/i.test(post.document.file_name || '')) {
    try {
      await attachLyrics(env, post);
    } catch {
      // 重新发一次就好
    }
    return text('ok');
  }
  // 图片帖：记下来，给没有封面的歌当封面
  if (post.photo && post.photo.length) {
    await lib(env).addPhoto(post.message_id, pickPhotoSize(post.photo));
    return text('ok');
  }
  const rec = toRecord(post);
  // 新帖是已有的歌（歌名、歌手一样，时长差 3 秒以内）：不再进歌单。编辑已登记的帖子不算
  if (rec && update.channel_post && (await lib(env).findSame(rec))) return text('ok');
  if (rec) {
    const fresh = await lib(env).upsertTrack(rec);
    // 新进来的歌（不管是手动发的、夜里自动搬的还是机器人搬的）：按类型放进对应的歌单
    if (fresh && update.channel_post) {
      // 贴网址搬来的自己的歌（帖子说明里有「授权：」「来源：」）：设置里指定了歌单就放那个歌单，没指定就按类型分
      const harvested = /^授权：/m.test(rec.caption) && /^来源：/m.test(rec.caption);
      const target = harvested ? (await lib(env).getHarvest()).playlist : '';
      // 搬来的多是外语、纯音乐：分不出类型时不硬塞「华语流行」，只留在「全部」
      await lib(env).addToPlaylists(rec.id, target ? [target] : genresOf(summary(rec), !harvested));
    }
  } else if (update.edited_channel_post) await lib(env).removeTrack(post.message_id); // 编辑后已不含音频
  forget(post.message_id);
  return text('ok');
}


function toRecord(post) {
  let kind, f;
  if (post.audio) { kind = 'audio'; f = post.audio; }
  else if (post.voice) { kind = 'voice'; f = post.voice; }
  else if (post.document && isAudioDocument(post.document)) { kind = 'document'; f = post.document; }
  else return null;

  const id = post.message_id;
  const name = f.file_name || '';
  const caption = (post.caption || '').trim();
  return {
    id,
    kind,
    file_id: f.file_id,
    file_unique_id: f.file_unique_id || '',
    // 音乐文件自带的专辑封面；空字符串表示确定没有（更早登记的歌没有这个字段，封面要靠流式服务去取）
    thumb: (f.thumbnail || f.thumb || {}).file_id || '',
    title: f.title || stripExt(name) || caption.split('\n')[0].trim() || (kind === 'voice' ? '语音' : '未命名') + ' #' + id,
    performer: f.performer || '',
    name,
    mime: pickMime(name, f.mime_type, kind),
    size: f.file_size || 0,
    duration: f.duration || 0,
    date: post.date || 0,
    caption,
  };
}

// 边长不超过 800 的最大一档；都超过就取最小的
function pickPhotoSize(sizes) {
  const area = s => (s.width || 0) * (s.height || 0);
  const fit = sizes.filter(s => Math.max(s.width || 0, s.height || 0) <= 800);
  const pool = fit.length ? fit : sizes;
  return pool.reduce((a, b) => (fit.length ? area(b) > area(a) : area(b) < area(a)) ? b : a).file_id;
}

function isAudioDocument(d) {
  const t = d.mime_type || '';
  if (t.startsWith('audio/')) return true;
  if (t.startsWith('video/') || t.startsWith('image/')) return false;
  return Object.hasOwn(MIME_BY_EXT, extOf(d.file_name));
}

function pickMime(name, telegramMime, kind) {
  // Telegram 报的类型不可靠（.m4a 也会报成 audio/mpeg），优先按扩展名
  const ext = extOf(name);
  if (Object.hasOwn(MIME_BY_EXT, ext)) return MIME_BY_EXT[ext];
  if (kind === 'voice') return 'audio/ogg';
  return telegramMime && telegramMime.startsWith('audio/') ? telegramMime : 'application/octet-stream';
}

// ── 管理接口 ─────────────────────────────────────────────────────

async function adminApi(request, env, url) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.ADMIN_KEY || !sameString(key, env.ADMIN_KEY)) return json({ error: '管理密钥不对' }, 401);

  const action = url.pathname.slice('/admin/api/'.length);
  if (action === 'state' && request.method === 'GET') {
    return json({ channel: env.CHANNEL_USERNAME || '', streamer: streamerOn(env), tracks: await tracksFor(env), playlists: await lib(env).listPlaylists() });
  }
  // 整体设置歌单：{ playlists: [{ id?, name, cover?, tracks: [消息号...] }] }，顺序就是显示顺序
  if (action === 'playlists' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const list = Array.isArray(body.playlists) ? body.playlists : null;
    const ok = list && list.length <= 100 && list.every(p => p && typeof p.name === 'string' && p.name.trim() && p.name.length <= 40 &&
      Array.isArray(p.tracks) && p.tracks.length <= 5000 && p.tracks.every(Number.isInteger) &&
      (p.id === undefined || Number.isInteger(p.id)) && (p.cover === undefined || Number.isInteger(p.cover)));
    if (!ok) return json({ error: '参数不对' }, 400);
    const saved = await lib(env).setPlaylists(list.map(p => ({ id: p.id, name: p.name.trim(), cover: p.cover, tracks: [...new Set(p.tracks)] })));
    listCache = null;
    return json({ ok: true, playlists: saved });
  }
  // 手动跑一次「夜里自动搬」（测试、或者想马上搬）
  if (action === 'auto-run' && request.method === 'POST') return json(await nightly(env));
  if (action === 'auto-state') return json(await lib(env).getAuto());
  if (action === 'remove' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const track = Number(body.track);
    if (!Number.isInteger(track)) return json({ error: '参数不对' }, 400);
    await lib(env).removeTrack(track);
    forget(track);
    return json({ ok: true });
  }
  // 搬歌用的「音乐来源频道」名单：{sources: [用户名...]}；GET 取、POST 整个换掉
  if (action === 'sources') {
    if (request.method === 'GET') return json({ sources: await lib(env).getSources() });
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const list = Array.isArray(body.sources) ? body.sources.map(s => String(s).trim().replace(/^@/, '')) : null;
      if (!list || list.length > 500 || !list.every(s => /^\w{4,64}$/.test(s))) return json({ error: '参数不对' }, 400);
      return json({ ok: true, sources: await lib(env).setSources([...new Set(list)]) });
    }
  }
  // 这首现在的封面不要了（比如别的频道的台标）：用这张图的歌都改用频道图片，以后也不再用它
  // 频道里新加了图片：没有自带封面、用着频道图片的歌清掉封面，下次打开时从现在的图库里重新挑
  if (action === 'reshuffle-photo-covers' && request.method === 'POST') {
    return json({ ok: true, cleared: await lib(env).clearPhotoCovers() });
  }
  if (action === 'ban-cover' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const track = Number(body.track);
    if (!Number.isInteger(track)) return json({ error: '参数不对' }, 400);
    const affected = await lib(env).banCover(track);
    return json({ ok: true, affected });
  }
  return json({ error: 'Not Found' }, 404);
}

// ── 歌单 ─────────────────────────────────────────────────────────

// 大文件能不能播，取决于流式服务配没配
async function tracksFor(env) {
  const on = streamerOn(env);
  return (await lib(env).listTracks()).map(t => {
    const big = t.size > BOT_DOWNLOAD_LIMIT;
    return { ...t, big, playable: !big || on };
  });
}

async function listBody(env) {
  const [tracks, playlists, hot, grey] = await Promise.all([tracksFor(env), lib(env).listPlaylists(), lib(env).listHot(), lib(env).listGrey()]);
  return JSON.stringify({
    channel: env.CHANNEL_USERNAME || '', tracks, playlists, hot: hotOrder(tracks, hot.songs), pics: hot.pics,
    grey: stillGrey(grey, tracks).map(({ sid, title, artist, album, year, duration, why }) => ({ sid, title, artist, album, year, duration, why })),
  });
}

async function trackList(env) {
  const now = Date.now();
  if (!listCache || listCache.exp < now) {
    try {
      listCache = { body: await listBody(env), exp: now + LIST_TTL_MS };
    } catch (e) {
      // 数据库读不了：给 KV 里最近一小时的快照，网页照样能打开、能听
      const snap = env.TRACKS ? await env.TRACKS.get(SNAP_TRACKS).catch(() => null) : null;
      if (!snap) throw e;
      console.log('degraded: /api/tracks from snapshot', String(e));
      return new Response(snap, {
        headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Degraded': '1' }),
      });
    }
  }
  return new Response(listCache.body, {
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=15' }),
  });
}

async function getRec(env, id) {
  const hit = recCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.rec;
  let rec;
  try {
    rec = await lib(env).getTrack(id);
  } catch (e) {
    const recs = await snapshotRecs(env);  // 数据库读不了：用快照里的文件信息照样放
    if (!recs) throw e;
    return recs[id] || null;
  }
  if (recCache.size > 500) recCache.clear();
  recCache.set(id, { rec, exp: Date.now() + REC_TTL_MS });
  return rec;
}

// ── 灰色歌：网易云上没有音源（没版权、下架、要单独购买）的歌，不下载，只记信息 ──
// 流式服务发歌时遇到了就记在它内存里（harvest/job.py 的 _remember_grey），Worker 每小时（还有频道主发「进度」「灰色歌」时）
// 来 GET /harvest/grey 取走存进数据库：流式服务连不到 Worker，只能 Worker 去取。网页上显示成灰色、不能播；
// 有新的就把整份清单做成 txt 发给频道主
const GREY_FIELDS = { sid: 20, title: 200, artist: 200, album: 200, year: 4, why: 40, page: 200 };

function cleanGrey(g) {
  if (!g || typeof g !== 'object') return null;
  const out = {};
  for (const [k, n] of Object.entries(GREY_FIELDS)) out[k] = String(g[k] == null ? '' : g[k]).slice(0, n);
  if (!/^\d{1,20}$/.test(out.sid) || !out.title) return null;
  if (out.page && !/^https:\/\/music\.163\.com\//.test(out.page)) out.page = '';
  out.duration = Math.max(0, Math.min(Math.round(Number(g.duration) || 0), 36000));
  out.pop = Math.max(0, Math.min(Math.round(Number(g.pop) || 0), 100));
  return out;
}

// 后来有了音源、搬进来了的（同名同歌手）就不再算灰色
function stillGrey(grey, tracks) {
  const have = new Set(tracks.map(t => norm(t.title) + '|' + norm(t.artist)));
  return grey.filter(g => !have.has(norm(g.title) + '|' + norm(g.artist)));
}

// → 这次新记下几首。有新的：网页的歌单缓存作废，清单 txt 发给频道主
async function pullGrey(env) {
  if (!streamerOn(env)) return 0;
  const { status, data } = await streamerCall(env, '/harvest/grey');
  if (status !== 200 || !Array.isArray(data.songs)) return 0;
  const fresh = await lib(env).addGrey(data.songs.map(cleanGrey).filter(Boolean).slice(0, 2000));
  if (fresh) {
    listCache = null;
    const owner = await ownerId(env);
    if (owner) await sendGreyFile(env, owner, fresh);
  }
  return fresh;
}

function fmtYearTime(g) {
  return [g.year, g.duration ? fmt(g.duration) : ''].filter(Boolean).join(' · ');
}
function fmt(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// 清单：按歌手分组（歌多的歌手在前），每首一行歌名、专辑、年份、时长、为什么没音源、热度，下一行网易云地址
function greyText(grey) {
  const by = new Map();
  for (const g of grey) {
    const a = g.artist || '（没写歌手）';
    if (!by.has(a)) by.set(a, []);
    by.get(a).push(g);
  }
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const lines = [`小橘音乐 · 灰色歌（网易云上没有音源，只记了信息）`, `共 ${grey.length} 首，${by.size} 位歌手，${day} 更新`, ''];
  for (const [a, songs] of [...by].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0], 'zh'))) {
    lines.push(`【${a}】${songs.length} 首`);
    for (const g of songs.sort((x, y) => y.pop - x.pop)) {
      const meta = [g.album && `《${g.album}》`, fmtYearTime(g), g.why, g.pop ? `热度 ${g.pop}` : ''].filter(Boolean).join(' · ');
      lines.push(`  ${g.title}${meta ? ' — ' + meta : ''}`);
      if (g.page) lines.push(`    ${g.page}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// 清单只有一份：第一次发成文件、置顶，记下是哪条（config 的 greyMsg）；以后有新的就替换那条消息里的文件，聊天里不会一堆同名文件。
// 替换文件不响通知，所以有新增时另发一句短提示。那条被删了（替换失败）就重发一条再置顶。
// fresh：这次新增几首（0 = 没有新增，比如频道主自己要）；asked：频道主发「灰色歌」要的，回一句清单在哪
async function sendGreyFile(env, chat, fresh, asked) {
  const L = lib(env);
  const grey = stillGrey(await L.listGrey(), await L.listTracks());
  if (!grey.length) return say(env, chat, '还没有灰色歌：同步小号、发审核通过的歌时，网易云上没有音源的会记在这里。');
  const artists = new Set(grey.map(g => g.artist)).size;
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
  const caption = `⬜ 灰色歌清单（网易云上没有音源，只记了信息）：共 ${grey.length} 首，${artists} 位歌手，${day} 更新` + (fresh ? `，新增 ${fresh} 首` : '');
  const file = () => new Blob([greyText(grey)], { type: 'text/plain;charset=utf-8' });
  const saved = JSON.parse((await L.getConfig('greyMsg')) || '{}');
  let msgId = 0;
  if (saved.id && String(saved.chat) === String(chat)) {
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append('message_id', String(saved.id));
    form.append('media', JSON.stringify({ type: 'document', media: 'attach://list', caption }));
    form.append('list', file(), GREY_FILE);
    const r = await tgForm(env, 'editMessageMedia', form);
    if (r.ok || /not modified/i.test(r.description || '')) msgId = saved.id;
  }
  if (!msgId) {  // 第一次，或者原来那条被删了：重发一条，置顶
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append('caption', caption);
    form.append('document', file(), GREY_FILE);
    const r = await tgForm(env, 'sendDocument', form);
    msgId = r.ok && r.result && r.result.message_id;
    if (!msgId) return say(env, chat, '灰色歌清单发不出去，过一会儿发「灰色歌」再试');
    await L.setConfig('greyMsg', JSON.stringify({ chat: String(chat), id: msgId }));
    await tg(env, 'pinChatMessage', { chat_id: chat, message_id: msgId, disable_notification: true });
    return null;  // 新文件本身会响通知，不用再说
  }
  if (fresh || asked) {
    const note = fresh ? `⬜ 灰色歌清单更新了：新增 ${fresh} 首，现在共 ${grey.length} 首。就是置顶的那个文件` : `⬜ 灰色歌清单就是置顶的那个文件（刚更新过，共 ${grey.length} 首）`;
    return tg(env, 'sendMessage', { chat_id: chat, text: note, reply_parameters: { message_id: msgId, allow_sending_without_reply: true } });
  }
  return null;
}

const GREY_FILE = '小橘音乐-灰色歌.txt';

async function tgForm(env, method, form) {
  const res = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/${method}`, { method: 'POST', body: form });
  return res.json().catch(() => ({}));
}

// ── 数据库挂了时的兜底：KV 里的快照 ──
// Durable Object 出错（多半是免费版每天 500 万行的读取额度用完了）时，网页照样能打开、能听：
// 歌单 JSON 和每首歌的文件信息（file_id 等，只在服务端用）每小时存一份到 KV（TRACKS，原来只在 DO 第一次启动时迁数据用）。
// KV 免费版每天只能写 1000 次：只在定时任务里每小时写两条（一天 48 次），绝不在请求里写。
// KV 是全球同步的，比边缘缓存（只在一个机房、workers.dev 上不一定生效）靠得住。
// 封面、歌词、音柱不进快照：挂的时候网页画文字封面、不显示歌词
const SNAP_TRACKS = 'snapshot:tracks';
const SNAP_RECS = 'snapshot:recs';
let snapRecs = null;  // { recs, exp } 兜底时从 KV 读出来的文件信息：播放一首歌要请求好几次，记 10 分钟，省 KV 的读取次数

async function saveSnapshot(env) {
  if (!env.TRACKS || !env.TRACKS.put) return false;
  const [body, recs] = await Promise.all([listBody(env), lib(env).listRecs()]);
  await env.TRACKS.put(SNAP_TRACKS, body);
  await env.TRACKS.put(SNAP_RECS, JSON.stringify(recs));
  return true;
}

async function snapshotRecs(env) {
  if (snapRecs && snapRecs.exp > Date.now()) return snapRecs.recs;
  const recs = env.TRACKS ? await env.TRACKS.get(SNAP_RECS, 'json').catch(() => null) : null;
  if (recs) snapRecs = { recs, exp: Date.now() + 600e3 };
  return recs;
}

function forget(id) {
  recCache.delete(id);
  listCache = null;
}

// ── 封面 ─────────────────────────────────────────────────────────

// 先看数据库里存没存；没有就去取一次（新歌用 Bot API 取缩略图，更早的歌请流式服务用 MTProto 取），
// 取到了（或确定没有）就存起来，以后不再惊动 Telegram 和流式服务
// artOnly：只要这首歌自己的专辑图（播放页、歌曲列表用）；配的频道图片当作没有，网页改画文字封面。
// 歌单宫格不带 artOnly，频道图片照样给
async function cover(env, id, artOnly) {
  const L = lib(env);
  let c = await L.getCover(id);
  if (!c) {
    const rec = await getRec(env, id);
    if (!rec) throw new HttpError(404, '没有这首歌');
    let got = await fetchCover(env, rec), own = true;
    if (got && got !== 'none' && (await L.isLogo(toBase64(got.data)))) got = 'none'; // 别的频道的台标，不算封面
    if (got === 'none') {  // 文件没自带封面：先找网易云上这首的专辑封面，没有再从频道图片里挑
      let art;
      try {
        art = await neteaseCover({ ...summary(rec), neteaseId: neteaseIdOf(rec) });
      } catch {
        throw new HttpError(503, '封面暂时取不到', { 'Retry-After': '60' });  // 网易云这次出错：别存，下次再找
      }
      if (art) got = art;
      else { got = await photoCover(env); own = false; }
    }
    if (!got) throw new HttpError(503, '封面暂时取不到', { 'Retry-After': '60' });
    c = got === 'none' ? { none: true } : { mime: got.mime, b64: toBase64(got.data), own };
    await L.putCover(id, c.none ? 'none' : c.mime, c.none ? '' : c.b64, c.none ? 0 : own);
  }
  if (c.none || (artOnly && !c.own)) throw new HttpError(404, '这首没有封面', { 'Cache-Control': 'public, max-age=86400' });
  return new Response(fromBase64(c.b64), {
    headers: cors({ 'Content-Type': c.mime, 'Cache-Control': 'public, max-age=604800' }),
  });
}

// ── 音柱数据 ─────────────────────────────────────────────────────
// 每首歌各频段随时间的响度（格式见流式服务的 pack_viz），第一次请流式服务算，存下来以后直接给。
// 网页按播放进度画音柱，iPhone 上也能跟着歌真的跳
async function viz(env, id) {
  const L = lib(env);
  let b64 = await L.getViz(id);
  if (b64 === null) {
    if (!(await getRec(env, id))) throw new HttpError(404, '没有这首歌');
    if (!streamerOn(env)) throw new HttpError(503, '暂时算不了', { 'Retry-After': '300' });
    let res;
    try {
      res = await fetch(`${streamerBase(env)}/viz/${id}`, {
        headers: { 'X-Key': env.STREAMER_KEY },
        signal: AbortSignal.timeout(VIZ_WAIT_MS),
      });
    } catch {
      throw new HttpError(503, '暂时算不了', { 'Retry-After': '30' });
    }
    // 流式服务自己的 404（JSON）才是「这首算不了」；Hugging Face 的错误页不算
    if (res.status === 404 && (res.headers.get('Content-Type') || '').includes('json')) {
      if (res.body) await res.body.cancel();
      b64 = '';
    } else {
      const buf = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      if (!buf || buf.length < 5 || buf[0] !== 0x58 || buf[1] !== 0x56) {
        if (res.body && !res.bodyUsed) await res.body.cancel();
        throw new HttpError(503, '暂时算不了', { 'Retry-After': '30' });
      }
      b64 = toBase64(buf);
    }
    await L.putViz(id, b64);
  }
  if (!b64) throw new HttpError(404, '这首没有音柱数据', { 'Cache-Control': 'public, max-age=86400' });
  return new Response(fromBase64(b64), {
    headers: cors({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000' }),
  });
}

// ── 自检（每小时一次，也可以私聊机器人发「自检」）：网易云登录了没有、用它试下载小号热门歌、频道主账号能不能往频道发帖 ──
// 结果存在 config 的 health，「搬运设置」里显示；流式服务也写进日志
const CHECK_EVERY_MS = 60 * 60 * 1000;

async function selfCheck(env, force) {
  const L = lib(env);
  const last = JSON.parse((await L.getConfig('health')) || '{}');
  if (!force && Date.now() - (last.at || 0) < CHECK_EVERY_MS) return last;
  if (!streamerOn(env)) return last;
  await L.setConfig('health', JSON.stringify({ ...last, at: Date.now() }));  // 先占住，免得下一分钟又跑一遍
  let r;
  try {
    r = await streamerCall(env, '/netease/check', {
      cookie: (await neteaseAccount(env)).cookie || '', alts: (await getAlts(env)).map(a => a.url),
    });
  } catch {
    r = { status: 0 };
  }
  if (r.status !== 200) {  // 流式服务睡着、还没部署好：不占这一小时，下一分钟再试
    console.log('self-check: streamer answered', r.status, JSON.stringify(r.data || {}).slice(0, 200));
    await L.setConfig('health', JSON.stringify(last));
    return last;
  }
  const health = { ...r.data, at: Date.now() };
  await L.setConfig('health', JSON.stringify(health));
  return health;
}

function healthLines(h) {
  if (!h || !h.at || h.login === undefined) return ['自检：还没跑过（每小时自动跑；发「自检」现在跑）'];
  const when = new Date(h.at + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
  const lines = [`自检（${when}）：`];
  lines.push(h.login ? `· 网易云：已登录「${h.nickname}」` : '· 网易云：没登录或登录过期了，VIP 歌下不了（发「网易云登录」扫码）');
  if (h.songs && h.songs.length) {
    const ok = h.songs.filter(x => x.ok);
    lines.push(`· 试下载小号热门歌 ${h.songs.length} 首：${ok.length} 首能下完整的` +
      (ok.length < h.songs.length ? `；${h.songs.filter(x => !x.ok).map(x => `${x.title}：${x.why}`).join('；')}` : ''));
  } else if (h.login) {
    lines.push('· 试下载：还没加小号，没歌可试');
  }
  if (h.channel) lines.push(h.channel.ok ? `· 频道：能往「${h.channel.title}」发帖` : `· 频道：发不了帖（${h.channel.why || '频道主账号不是管理员'}）`);
  if (h.error) lines.push(`· 出错：${h.error}`);
  return lines;
}

// ── 后台补封面、歌词：每分钟挑一批还没找过（或该再找）的歌先找好存起来，打开时直接就有 ──
// 每 5 分钟按消息号顺序看下一段 FILL_BATCH 首（记着看到哪了，看到头再从头来）：只读几十行。
// 别扫全库：免费版 Durable Object 每天只能读 500 万行，每分钟扫全库会把一天的额度用光，整个网站都读不了。
// 一批不大：免费版 Worker 一次最多 50 个子请求；连着出错（服务睡着、网易云抽风）就停，下一轮接着来
const FILL_CRON = '*/5 * * * *';
const FILL_BATCH = 8;

async function fillMissing(env) {
  const { covers, lyrics: words } = await lib(env).missingArt(FILL_BATCH, Date.now());
  const jobs = [...covers.map(id => () => cover(env, id, false)), ...words.map(id => () => lyrics(env, id))];
  let done = 0, fails = 0;
  for (const job of jobs) {
    if (fails >= 3) break;
    try {
      const res = await job();
      if (res && res.body) await res.body.cancel();
      done++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) done++;  // 确定没有（已经记下了）
      else fails++;
    }
  }
  // 这一轮没有封面、歌词要补时，才补一位歌手的热门歌（2 个子请求、解析一个 100 多 KB 的 JSON）：
  // 免费版一次调用只有 50 个子请求、10 毫秒 CPU，别和补封面歌词挤在同一轮
  let hot = 0;
  if (!jobs.length) {
    const L = lib(env);
    for (const name of await L.missingHot(HOT_BATCH, Date.now())) {
      try {
        const { songs, pic } = await neteaseHot(name);
        await L.putHot(name, songs, Date.now() + (songs.length ? HOT_REFRESH_MS : HOT_MISS_MS), pic);
        hot++;
        listCache = null;
      } catch {
        fails++;
        break;  // 网易云抽风：下一轮再来，什么也不存
      }
    }
  }
  return { done, fails, covers: covers.length, lyrics: words.length, hot };
}

// 同步小号时顺手把这几个号的热门 50 首记下来，网页歌手页马上按它排，不用等后台慢慢轮到。
// 小号记着网易云歌手编号，按编号认人（顺带拿头像）：一个号 2 个子请求。最多 ALT_HOT_MOST 个，其余的交给后台补全；出错就算了，后台会再取
const ALT_HOT_MOST = 5;
async function altHot(env, alts) {
  const L = lib(env);
  for (const a of alts.filter(x => x.id && x.name).slice(0, ALT_HOT_MOST)) {
    try {
      const { songs, pic } = await neteaseHot(a.name, a.id);
      if (songs.length) await L.putHot(a.name, songs, Date.now() + HOT_REFRESH_MS, pic);
    } catch {
      // 网易云抽风：留给后台补全
    }
  }
  listCache = null;
}

// ── 歌手的热门歌：网易云歌手页的「热门 50 首」。网页的歌手页按它排，不然新搬来的冷门歌全排在前面 ──
const HOT_BATCH = 1;                  // 每轮最多补几位歌手（一天最多 288 位；歌多的歌手先，常听的头几个小时就有了）
const HOT_REFRESH_MS = 7 * DAY_MS;    // 热门会变：一周重取一次
const HOT_MISS_MS = 30 * DAY_MS;      // 网易云上找不到这位歌手：一个月后再试

// 「A&B」「A、B」这样合唱的歌，两位歌手都算（和 page.html 的 artistsOf() 拆法一样，歌手页的名字才对得上）
function artistsOf(artist) {
  return String(artist || '').split(/[&＆、/,，]| x | feat\.? /i).map(a => a.trim()).filter(Boolean);
}

// → { songs: 这位歌手的热门歌名（按网易云的顺序）, pic: 歌手照片地址 }；songs 为 [] = 网易云上没有叫这个名字的歌手。
// 知道网易云歌手编号（小号）就按编号认人，搜不到也照样按编号取热门歌。出错（超时、风控）抛异常，下次再试
async function neteaseHot(name, id = '') {
  const want = norm(name);
  if (!want && !id) return { songs: [], pic: '' };
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  const q = new URLSearchParams({ s: name, type: '100', limit: '10', offset: '0' });
  const j = await getJson(`${NETEASE}/search/get?${q}`, { headers });
  if (!j || j.code !== 200) throw new Error(`search/get → code ${j && j.code}`);
  // 名字要完全一样（或者是别名、译名）才算：搜歌手会顺带出名字像的人
  const found = (j.result && j.result.artists) || [];
  const a = (id && found.find(x => String(x.id) === String(id))) || (!id && found.find(x =>
    [x.name, x.trans, ...(x.alias || []), ...(x.transNames || [])].some(n => want && norm(n) === want)));
  if (!a && !id) return { songs: [], pic: '' };
  const pic = String((a && a.picUrl) || '').replace(/^http:/, 'https:');
  return { songs: await neteaseTopSongs(id || a.id), pic: /^https:\/\/p\d+\.music\.126\.net\//.test(pic) ? pic : '' };
}

// 网易云歌手编号 → 热门 50 首的歌名（按网易云的顺序）。出错抛异常
async function neteaseTopSongs(id) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  const d = await getJson(`${NETEASE}/artist/top/song?id=${encodeURIComponent(id)}`, { headers });
  if (!d || d.code !== 200) throw new Error(`artist/top/song → code ${d && d.code}`);
  return (d.songs || []).map(x => String(x.name || '')).filter(Boolean).slice(0, 50);
}

// 每位歌手：我们库里能对上网易云热门 50 首的歌，按热门的顺序排好的消息号。网页歌手页把这些排最前面，其余照旧（新的在前）。
// 歌名先比原样，再比去掉「(Live)」「DJ版」之类版本说明的；同一名次原版排在翻版前面
function hotOrder(tracks, hot) {
  const by = new Map();
  for (const t of tracks) {
    for (const a of artistsOf(t.artist)) {
      if (!hot[a]) continue;
      if (!by.has(a)) by.set(a, []);
      by.get(a).push(t);
    }
  }
  const out = {};
  for (const [a, songs] of by) {
    const exact = new Map(), loose = new Map();
    hot[a].forEach((name, i) => {
      if (!exact.has(norm(name))) exact.set(norm(name), i);
      if (!loose.has(norm(cleanTitle(name)))) loose.set(norm(cleanTitle(name)), i);
    });
    const hit = songs.map(t => {
      const e = exact.get(norm(t.title));
      return { id: t.id, r: e ?? loose.get(norm(cleanTitle(t.title))), loose: e === undefined ? 1 : 0 };
    }).filter(x => x.r !== undefined).sort((x, y) => x.r - y.r || x.loose - y.loose);
    if (hit.length) out[a] = hit.map(x => x.id);
  }
  return out;
}

// 网易云上这首歌的专辑封面（500×500）→ { mime, data }；没找到 → null；网易云出错就抛。
// 搬来的歌按编号认；别的要歌名、歌手对上，时长相差 COVER_SLACK_S 秒以内（别的版本的封面不要）
const COVER_SLACK_S = 10;
async function neteaseCover(t) {
  if (!t.title || t.kind === 'voice') return null;
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  for (const title of titlesFor(t.title)) {
    const body = new URLSearchParams({ s: (title + ' ' + t.artist).trim(), type: '1', limit: '10', offset: '0' });
    const j = await getJson(NETEASE + '/cloudsearch/pc', { method: 'POST', body, headers });
    const songs = (j && j.result && j.result.songs) || [];
    const want = norm(cleanTitle(title));
    let s = t.neteaseId && songs.find(x => String(x.id) === t.neteaseId);
    if (!s) {
      s = songs
        .filter(x => want && norm(x.name).includes(want) && (!t.artist || (x.ar || []).some(a => sameArtist(t.artist, a.name))))
        .map(x => ({ x, diff: Math.abs((x.dt || 0) / 1000 - t.duration) }))
        .filter(p => p.diff <= COVER_SLACK_S)
        .sort((a, b) => a.diff - b.diff)
        .map(p => p.x)[0];
    }
    const pic = s && s.al && s.al.picUrl;
    if (pic) {
      const res = await fetch(pic.replace(/^http:/, 'https:') + '?param=500y500', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(LYRICS_WAIT_MS) });
      const img = await imageFrom(res, 'image/jpeg');
      if (img) return img;
    }
  }
  return null;
}

// 返回 { mime, data }；'none' 表示确定没有封面；null 表示这次没取到（别存，下次再试）
async function fetchCover(env, rec) {
  if (rec.kind === 'voice' || rec.thumb === '') return 'none';
  try {
    if (rec.thumb) {
      const res = await fetchFile(env, rec.thumb, null);
      return await imageFrom(res, 'image/jpeg');
    }
    if (!streamerOn(env)) return null;
    const res = await fetch(`${streamerBase(env)}/thumb/${rec.id}`, {
      headers: { 'X-Key': env.STREAMER_KEY },
      signal: AbortSignal.timeout(STREAMER_WAIT_MS),
    });
    // 流式服务自己的 404 是 JSON；Hugging Face 的错误页是网页，不能当成「没有封面」
    if (res.status === 404 && (res.headers.get('Content-Type') || '').includes('json')) {
      if (res.body) await res.body.cancel();
      return 'none';
    }
    return await imageFrom(res, null);
  } catch {
    return null;
  }
}

// 从频道的图片帖里随机挑一张。更早的图片帖 webhook 没见过，第一次用时请流式服务按消息号扫一遍
async function photoCover(env) {
  const L = lib(env);
  if (!(await L.getFlag('photosScanned'))) {
    if (!streamerOn(env)) return null;
    try {
      const res = await fetch(`${streamerBase(env)}/photos?upto=${(await L.maxTrackId()) + 300}`, {
        headers: { 'X-Key': env.STREAMER_KEY },
        signal: AbortSignal.timeout(60 * 1000),
      });
      const j = res.ok ? await res.json().catch(() => null) : null;
      if (!j || !Array.isArray(j.photos)) return null;
      await L.addScannedPhotos(j.photos.filter(Number.isInteger));
      await L.setFlag('photosScanned');
    } catch {
      return null;
    }
  }
  const photos = await L.listPhotos();
  if (!photos.length) return 'none';
  for (let i = 0; i < 3; i++) {
    const img = await fetchPhoto(env, photos[Math.floor(Math.random() * photos.length)]);
    if (img) return img;
  }
  return null;
}

async function fetchPhoto(env, p) {
  try {
    if (p.file_id) return await imageFrom(await fetchFile(env, p.file_id, null), 'image/jpeg');
    if (!streamerOn(env)) return null;
    const res = await fetch(`${streamerBase(env)}/photo/${p.id}`, {
      headers: { 'X-Key': env.STREAMER_KEY },
      signal: AbortSignal.timeout(STREAMER_WAIT_MS),
    });
    return await imageFrom(res, null);
  } catch {
    return null;
  }
}

async function imageFrom(res, fallbackMime) {
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim();
  const mime = type.startsWith('image/') ? type : fallbackMime;
  if (!res.ok || !mime) {
    if (res.body) await res.body.cancel();
    return null;
  }
  const data = new Uint8Array(await res.arrayBuffer());
  return data.length && data.length <= COVER_LIMIT ? { mime, data } : null;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ── 歌词 ─────────────────────────────────────────────────────────

// 先看数据库；没有（或者上次没找到、到了该再找的时候）就去外面找，找到什么都存起来。
// 外面两边都出错时，有旧结果就先给旧的，没有就 503
async function lyrics(env, id) {
  const L = lib(env);
  let row = await L.getLyrics(id);
  if (!row || (row.retry_at && row.retry_at < Date.now())) {
    const rec = await getRec(env, id);
    if (!rec) throw new HttpError(404, '没有这首歌');
    const found = await findLyrics({ ...summary(rec), neteaseId: neteaseIdOf(rec) });
    if (found) row = await L.putLyrics(id, found.src, found.lrc, found.retryAt);
    else if (!row) throw new HttpError(503, '歌词暂时取不到', { 'Retry-After': '60' });
  }
  const { synced, lines } = parseLrc(row.lrc);
  return new Response(JSON.stringify({ src: lines.length ? row.src : 'none', synced, lines }), {
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }),
  });
}

// 先找「时间轴对得上」的：LRCLIB 优先，没有再问网易云。都没有就退一步，用同一首歌别的版本的歌词，
// 只显示文字、不跟着滚。返回 { src, lrc, retryAt }（retryAt 为 0 表示不用再找）；两边都出错返回 null
async function findLyrics(t) {
  if (!t.title) return { src: 'none', lrc: '', retryAt: 0 };
  const a = await fromLrclib(t).catch(() => null);
  if (a && a.synced) return { ...a.synced, retryAt: 0 };
  const b = await fromNetease(t).catch(() => null);
  if (b && b.synced) return { ...b.synced, retryAt: 0 };
  if (!a && !b) return null;
  // 有一边这次出错了：先用着，过一天再找；否则只有文字的 30 天、完全没有的 14 天后再找（歌词库一直在长）
  const soon = !a || !b;
  const plain = (a && a.plain) || (b && b.plain);
  if (plain) return { ...plain, retryAt: Date.now() + (soon ? 1 : 30) * DAY_MS };
  return { src: 'none', lrc: '', retryAt: Date.now() + (soon ? 1 : 14) * DAY_MS };
}

// 返回 { synced, plain }：synced 是时长对得上、带时间轴的；plain 是同一首歌的文字歌词。出错就抛
async function fromLrclib(t) {
  let plain = null;
  for (const title of titlesFor(t.title)) {
    const q = { track_name: title };
    if (t.artist) q.artist_name = t.artist;
    let res = await getJson(LRCLIB + '?' + new URLSearchParams(q), { headers: { 'User-Agent': UA, 'Lrclib-Client': UA } });
    if ((!Array.isArray(res) || !res.length) && t.artist) {
      res = await getJson(LRCLIB + '?' + new URLSearchParams({ q: title + ' ' + t.artist }), { headers: { 'User-Agent': UA, 'Lrclib-Client': UA } });
    }
    const want = norm(cleanTitle(title));
    const hits = (Array.isArray(res) ? res : [])
      .filter(r => want && norm(r.trackName).includes(want) && !r.instrumental && sameArtist(t.artist, r.artistName))
      .map(r => ({ r, diff: Math.abs((r.duration || 0) - t.duration) }))
      .sort((x, y) => x.diff - y.diff);
    for (const { r, diff } of hits) {
      if (diff <= LYRICS_SLACK_S && isSynced(r.syncedLyrics)) return { synced: { src: 'lrclib', lrc: r.syncedLyrics }, plain: null };
      if (!plain) {
        const words = r.plainLyrics || plainText(r.syncedLyrics);
        if (words && words.trim()) plain = { src: 'lrclib', lrc: words };
      }
    }
  }
  return { synced: null, plain };
}

// 从网易云搬来的歌（帖子说明里有「来源：https://music.163.com/song?id=…」）：它在网易云上的编号，歌词、封面直接按它取
function neteaseIdOf(rec) {
  const m = /^来源：https?:\/\/music\.163\.com\/song\?id=(\d+)/m.exec(rec.caption || '');
  return m ? m[1] : '';
}

// 网易云：搬来的歌按编号直接取；别的搜歌（按歌名、歌手筛，时长最接近的两首），再取歌词
async function fromNetease(t) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  let plain = null;
  if (t.neteaseId) {  // 就是这一首，不用比时长
    const lj = await getJson(`${NETEASE}/song/lyric?id=${encodeURIComponent(t.neteaseId)}&lv=1&kv=1&tv=-1`, { headers });
    const lrc = (lj && lj.lrc && lj.lrc.lyric) || '';
    const words = plainText(lrc);
    if (words.trim() && !/^纯音乐，请欣赏/.test(words.trim())) {
      if (isSynced(lrc)) return { synced: { src: 'netease', lrc }, plain: null };
      plain = { src: 'netease', lrc: words };
    }
  }
  for (const title of titlesFor(t.title)) {
    const body = new URLSearchParams({ s: (title + ' ' + t.artist).trim(), type: '1', limit: '10', offset: '0' });
    const j = await getJson(NETEASE + '/cloudsearch/pc', { method: 'POST', body, headers });
    const want = norm(cleanTitle(title));
    const picks = ((j && j.result && j.result.songs) || [])
      .filter(s => want && norm(s.name).includes(want) && (!t.artist || (s.ar || []).some(a => sameArtist(t.artist, a.name))))
      .map(s => ({ id: s.id, diff: Math.abs((s.dt || 0) / 1000 - t.duration) }))
      .sort((x, y) => x.diff - y.diff)
      .slice(0, 2);
    for (const p of picks) {
      const lj = await getJson(`${NETEASE}/song/lyric?id=${encodeURIComponent(p.id)}&lv=1&kv=1&tv=-1`, { headers });
      const lrc = (lj && lj.lrc && lj.lrc.lyric) || '';
      const words = plainText(lrc);
      if (!words.trim() || /^纯音乐，请欣赏/.test(words.trim())) continue;
      if (p.diff <= LYRICS_SLACK_S && isSynced(lrc)) return { synced: { src: 'netease', lrc }, plain: null };
      if (!plain) plain = { src: 'netease', lrc: words };
    }
  }
  return { synced: null, plain };
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(LYRICS_WAIT_MS) });
  if (res.status === 404) {
    if (res.body) await res.body.cancel();
    return null;
  }
  if (!res.ok) {
    if (res.body) await res.body.cancel();
    throw new Error(`${url.split('?')[0]} → ${res.status}`);
  }
  return res.json();
}

// 先用完整歌名找，再用去掉「(DJ版)」「(Live)」之类版本说明的歌名找
function titlesFor(title) {
  return [...new Set([title, cleanTitle(title)])];
}

const VARIANT = /dj|版|remix|live|伴奏|加速|降调|0\.\d+x|抖音|片段|翻自|cover/i;
function cleanTitle(title) {
  let t = title.replace(/[(（[【][^)）\]】]*[)）\]】]/g, '');
  if (VARIANT.test(t)) t = t.replace(/\s*[-—].*$/, '');
  return t.trim() || title;
}

// 比较歌名、歌手时只看字母、数字和汉字
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// 我们这边的歌手可能是几个人（「A&B」「A、B」）；有一个对得上就算。我们这边没写歌手就不查
function sameArtist(ours, theirs) {
  const parts = String(ours || '').split(/[&、/,，]| x | feat\.? /).map(norm).filter(Boolean);
  if (!parts.length) return true;
  const th = norm(theirs);
  return !!th && parts.some(p => p.includes(th) || th.includes(p));
}

// 至少 5 句带时间、有字的歌词，才算真有时间轴
function isSynced(lrc) {
  const { synced, lines } = parseLrc(lrc);
  return synced && lines.filter(l => l[1]).length >= 5;
}

function plainText(lrc) {
  return parseLrc(lrc).lines.map(l => l[1]).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 解析 LRC，返回 { synced, lines: [[秒, 这句歌词], ...] }，按时间排好；没有时间轴时秒是 null。
// 认得：一行多个时间 [00:12.00][01:30.00]、[offset:毫秒]、逐字时间 <00:12.34>（去掉）、
// [ti:] [ar:] 之类的标签（跳过）、网易云开头几行 JSON 格式的演职员信息
function parseLrc(text) {
  const timed = [], plain = [];
  let offset = 0;
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line); // {"t":毫秒,"c":[{"tx":"作词: "},{"tx":"某某"}]}
        if (Number.isFinite(j.t) && Array.isArray(j.c)) timed.push([j.t / 1000, j.c.map(c => (c && c.tx) || '').join('').trim()]);
      } catch {
        plain.push(line);
      }
      continue;
    }
    const off = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
    if (off) {
      offset = Number(off[1]) / 1000; // 正数表示歌词整体提前
      continue;
    }
    const times = [];
    let rest = line, m;
    while ((m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
      times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0));
      rest = rest.slice(m[0].length);
    }
    const words = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (times.length) for (const t of times) timed.push([t, words]);
    else if (!/^\[[a-z#]+:[^\]]*\]$/i.test(line)) plain.push(words);
  }
  if (timed.some(l => l[1])) {
    const lines = timed.map(([t, w]) => [Math.max(0, Math.round((t - offset) * 100) / 100), w]).sort((a, b) => a[0] - b[0]);
    return { synced: true, lines };
  }
  return { synced: false, lines: plain.filter(Boolean).map(w => [null, w]) };
}

// 频道里回复某首歌发一个 .lrc 文件，就是这首的歌词（优先于自动找到的）。
// 没有回复具体哪首时按文件名找（「歌名.lrc」或「歌手 - 歌名.lrc」），只有唯一一首对得上才算
async function attachLyrics(env, post) {
  const doc = post.document;
  if (!doc.file_id || (doc.file_size || 0) > LRC_LIMIT) return;
  const L = lib(env);
  const reply = post.reply_to_message && post.reply_to_message.message_id;
  const id = Number.isInteger(reply) && (await L.getTrack(reply)) ? reply : await trackByFileName(env, doc.file_name);
  if (!id) return;
  const res = await fetchFile(env, doc.file_id, null);
  if (!res.ok) {
    if (res.body) await res.body.cancel();
    return;
  }
  const lrc = decodeText(new Uint8Array(await res.arrayBuffer()));
  if (parseLrc(lrc).lines.length) await L.putLyrics(id, 'manual', lrc, 0);
}

async function trackByFileName(env, fileName) {
  const base = norm(stripExt(fileName));
  if (!base) return null;
  const hits = (await lib(env).listTracks()).filter(t => {
    const title = norm(t.title), artist = norm(t.artist);
    return base === title || (artist && (base === artist + title || base === title + artist));
  });
  return hits.length === 1 ? hits[0].id : null;
}

// .lrc 多是 UTF-8，也有不少老的中文歌词是 GBK，偶尔还有 Windows 记事本存的 UTF-16
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // 不是 UTF-8
  }
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// ── 音频流 ───────────────────────────────────────────────────────

async function audio(request, env, id, download) {
  const rec = await getRec(env, id);
  if (!rec) throw new HttpError(404, '没有这首歌');
  const big = rec.size > BOT_DOWNLOAD_LIMIT;
  if (big && !streamerOn(env)) throw new HttpError(503, MSG.noStreamer);

  const headers = cors({
    'Content-Type': rec.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Content-Disposition': contentDisposition(rec, download),
  });
  if (request.method === 'HEAD') {
    if (rec.size) headers['Content-Length'] = String(rec.size);
    return new Response(null, { headers });
  }
  if (!rec.size) return await passthrough(request, env, rec, headers); // 没有登记大小的老记录：照旧透传

  const range = parseRange(request.headers.get('Range'), rec.size);
  if (!range) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${rec.size}`, 'Cache-Control': 'no-store' } });
  }
  headers['Content-Length'] = String(range.end - range.start + 1);
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${rec.size}`;
  const res = big ? await fromStreamer(env, rec, range) : await fromBotApi(env, rec, range);
  return new Response(res.body, { status: range.partial ? 206 : 200, headers });
}

// 返回 { start, end, partial }；null 表示范围没法满足（416）。认不出的格式、多段 Range 一律当作要整个文件
function parseRange(header, total) {
  const whole = { start: 0, end: total - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (!m[1] && !m[2])) return whole;
  if (!m[1]) {
    const n = Number(m[2]);
    return n > 0 ? { start: Math.max(0, total - n), end: total - 1, partial: true } : null;
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (start >= total) return null;
  if (end < start) return whole;
  return { start, end, partial: true };
}

// 要的是整个文件就不带 Range，上游回 200；否则带上算好的 Range，上游回 206
function upstreamRange(rec, range) {
  return range.start === 0 && range.end === rec.size - 1 ? null : `bytes=${range.start}-${range.end}`;
}

function bodyMatches(res, want, range, strict) {
  const len = res.headers.get('Content-Length');
  return res.status === (want ? 206 : 200) &&
    (len === null ? !strict : Number(len) === range.end - range.start + 1);
}

async function fromBotApi(env, rec, range) {
  const want = upstreamRange(rec, range);
  const res = await fetchFile(env, rec.file_id, want);
  if (!bodyMatches(res, want, range, false)) {
    if (res.body) res.body.cancel();
    throw new HttpError(502, MSG.unavailable);
  }
  return res;
}

async function fromStreamer(env, rec, range, path = `/stream/${rec.id}`) {
  const want = upstreamRange(rec, range);
  const headers = { 'X-Key': env.STREAMER_KEY };
  if (want) headers.Range = want;
  // 只限制等响应头的时间；拿到响应头后就不再计时，长歌可以一直传下去
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), STREAMER_WAIT_MS);
  let res;
  try {
    res = await fetch(`${streamerBase(env)}${path}`, { headers, signal: abort.signal });
  } catch {
    throw waking();
  } finally {
    clearTimeout(timer);
  }
  if (bodyMatches(res, want, range, true)) return res;
  if (res.status === 404) {
    const j = await res.json().catch(() => null);
    const e = new HttpError(404, MSG.gone);
    e.gone = !!j && j.detail === 'gone'; // 流式服务自己说的「频道里没这条」；Space 没有这个接口的 404 不算
    throw e;
  }
  if (res.body) res.body.cancel();
  // 5xx 或者一张网页（Hugging Face 的「正在启动」页）：服务还没醒
  if (res.status >= 500 || (res.headers.get('Content-Type') || '').includes('text/html')) throw waking();
  throw new HttpError(502, MSG.unavailable);
}

function waking() {
  return new HttpError(503, MSG.waking, { 'Retry-After': '15' });
}

async function passthrough(request, env, rec, headers) {
  const raw = (request.headers.get('Range') || '').trim();
  const res = await fetchFile(env, rec.file_id, /^bytes=(\d+-\d*|-\d+)$/.test(raw) ? raw : null);
  if (![200, 206, 416].includes(res.status)) {
    if (res.body) res.body.cancel();
    throw new HttpError(502, MSG.unavailable);
  }
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(res.body, { status: res.status, headers });
}

async function fetchFile(env, fileId, range) {
  for (let attempt = 0; ; attempt++) {
    const path = await filePath(env, fileId, attempt > 0);
    const res = await fetch(`${TG}/file/bot${env.TG_BOT_TOKEN}/${path}`, { headers: range ? { Range: range } : {} });
    // 缓存的下载路径过期会回 4xx：重新 getFile 换个新路径，再试一次
    if (attempt === 0 && [401, 403, 404].includes(res.status)) {
      if (res.body) res.body.cancel();
      continue;
    }
    return res;
  }
}

async function filePath(env, fileId, refresh) {
  const hit = filePaths.get(fileId);
  if (hit && !refresh && hit.exp > Date.now()) return hit.path;

  const r = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !j.result || !j.result.file_path) throw new HttpError(502, MSG.unavailable);
  if (filePaths.size > 500) filePaths.clear();
  filePaths.set(fileId, { path: j.result.file_path, exp: Date.now() + PATH_TTL_MS });
  return j.result.file_path;
}

function contentDisposition(rec, download) {
  const name = rec.name || rec.title + extFromMime(rec.mime);
  const fallback = 'track-' + rec.id + '.' + (extOf(name) || 'bin');
  // RFC 5987：encodeURIComponent 不转义 ' ( ) *，这里补上
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ── 数据：Durable Object「Library」────────────────────────────────

export class Library extends DurableObject {



  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, updated INTEGER NOT NULL)');
      // 封面存成 base64 文本（一张二三十 KB）；mime 为 'none' 表示确定没有封面
      this.sql.exec('CREATE TABLE IF NOT EXISTS covers (id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      // 频道里的图片帖；file_id 为空的是流式服务扫出来的老帖，要请它下载
      this.sql.exec("CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY, file_id TEXT NOT NULL DEFAULT '')");
      // 歌词：src 是 lrclib / netease / manual（频道里手动发的）/ none（确定没有）；lrc 是原文；
      // retry_at 不为 0 时，过了这个时间要再去外面找一次
      this.sql.exec('CREATE TABLE IF NOT EXISTS lyrics (id INTEGER PRIMARY KEY, src TEXT NOT NULL, lrc TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0)');
      // 管理员编的歌单：pos 是在歌单列表里的顺序，tracks 是消息号数组（JSON），按歌单里的顺序
      this.sql.exec('CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, pos INTEGER NOT NULL, name TEXT NOT NULL, cover INTEGER NOT NULL DEFAULT 0, tracks TEXT NOT NULL)');
      // 别的频道的台标：搬来的歌自带的「封面」常是那个频道的标志，好多首共用同一张。记下来的图不再当封面
      this.sql.exec('CREATE TABLE IF NOT EXISTS logo_covers (data TEXT PRIMARY KEY)');
      // 按图找封面（是不是台标、数几首共用）走索引，不扫整张 covers 表：免费版每天读的行数有限
      this.sql.exec('CREATE INDEX IF NOT EXISTS covers_data ON covers (data)');
      // 音柱数据：base64；空字符串表示确定算不了
      this.sql.exec('CREATE TABLE IF NOT EXISTS viz (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
      // 听众求歌的记录（限次用）
      this.sql.exec('CREATE TABLE IF NOT EXISTS asks (uid INTEGER NOT NULL, at INTEGER NOT NULL)');
      // 歌手在网易云的热门歌（歌手页排序用）：songs 是歌名 JSON 数组（[] = 网易云上没这位歌手），过了 retry_at 重取
      this.sql.exec('CREATE TABLE IF NOT EXISTS artist_hot (name TEXT PRIMARY KEY, songs TEXT NOT NULL, retry_at INTEGER NOT NULL)');
      // 灰色歌：网易云上没有音源、只记了信息的歌。sid 是网易云歌曲编号，info 是 JSON（见 worker 的 cleanGrey）
      this.sql.exec('CREATE TABLE IF NOT EXISTS grey (sid TEXT PRIMARY KEY, info TEXT NOT NULL, at INTEGER NOT NULL)');
      // pic：网易云的歌手照片地址（p*.music.126.net），歌手页当头像；空 = 还没有
      if (!this.sql.exec('PRAGMA table_info(artist_hot)').toArray().some(r => r.name === 'pic')) {
        this.sql.exec("ALTER TABLE artist_hot ADD COLUMN pic TEXT NOT NULL DEFAULT ''");
      }
      this.dropSplitterLeftovers();
      const coversV = this.cfg('coversV');
      // 以前没封面的歌记成了「没有」；现在改用频道图片，清掉这些记号让它们重新配图
      if (coversV !== '2' && coversV !== '3') this.sql.exec("DELETE FROM covers WHERE mime = 'none'");
      // 已经存下的台标封面：找出来记住，这些歌重新配图
      if (coversV !== '3') {
        const shared = this.sql.exec(`SELECT data FROM covers WHERE mime != 'none' GROUP BY data HAVING COUNT(*) >= ${LOGO_MIN_SONGS}`).toArray();
        for (const r of shared) this.markLogo(r.data);
        this.setCfg('coversV', '3');
      }
      // own：这张封面是不是歌自己带的（1）还是配的频道图片（0）。加这一列之前存的按下面的规则补：
      // 语音、确定没缩略图的 → 频道图片；有缩略图 file_id 的 → 自带；更早登记、说不清的删掉，下次请求时重新判断
      if (!this.sql.exec('PRAGMA table_info(covers)').toArray().some(r => r.name === 'own')) {
        this.sql.exec('ALTER TABLE covers ADD COLUMN own INTEGER NOT NULL DEFAULT 1');
        for (const r of this.sql.exec("SELECT s.id, s.rec FROM songs s JOIN covers c ON c.id = s.id WHERE c.mime != 'none'").toArray()) {
          const rec = JSON.parse(r.rec);
          if (rec.kind === 'voice' || rec.thumb === '') this.sql.exec('UPDATE covers SET own = 0 WHERE id = ?', r.id);
          else if (!rec.thumb) this.sql.exec('DELETE FROM covers WHERE id = ?', r.id);
        }
      }
      // 第一次启动：把更早版本存在 KV 里的歌单搬过来
      if (!this.cfg('migrated')) {
        if (env.TRACKS) await this.importKV(env.TRACKS);
        this.setCfg('migrated', '1');
      }
    });
  }

  // 试过「切片」方案的那一版把歌存在 tracks 表（多几列处理状态），还有 chats 表和仓库频道配置。
  // 换成流式后都用不上：歌搬进 songs，其余删掉。tracks 不存在时 INSERT 会报错，说明已经搬过了
  dropSplitterLeftovers() {
    try {
      this.sql.exec('INSERT OR IGNORE INTO songs (id, rec, updated) SELECT id, rec, updated FROM tracks');
      this.sql.exec('DROP TABLE tracks');
    } catch {
      // 没有旧表
    }
    this.sql.exec('DROP TABLE IF EXISTS chats');
    this.sql.exec("DELETE FROM config WHERE k IN ('storage', 'storageTitle')");
  }

  // art：这首有没有自己的专辑图（1 有 / 0 没有），封面还没判断过的不带。网页据此直接画文字封面，不用一首首去试。
  // 整张表读一遍是「歌数 × 2」行，每次打开网页都读会用掉免费版每天的读取额度：结果记在内存里，
  // songs、covers 一改（changed()）就作废
  async listTracks() {
    if (!this.tracks) {
      this.recs = new Map();
      this.tracks = this.sql.exec('SELECT s.rec, c.mime, c.own FROM songs s LEFT JOIN covers c ON c.id = s.id ORDER BY s.id DESC').toArray()
        .map(r => this.trackRow(r));
    }
    return this.tracks;
  }

  // 一行 songs（连着 covers）→ 网页要的那首；顺带记下放歌要的文件信息（快照用，见 saveSnapshot）
  trackRow(r) {
    const rec = JSON.parse(r.rec);
    const t = summary(rec);
    if (r.mime != null) t.art = r.mime !== 'none' && r.own ? 1 : 0;
    const { id, file_id, size, mime, name, title } = rec;
    this.recs.set(id, { id, file_id, size, mime, name, title });
    return t;
  }

  // 快照用：{ 消息号: 放歌要的文件信息 }。和 listTracks 是同一次读，不多读
  async listRecs() {
    await this.listTracks();
    return Object.fromEntries(this.recs);
  }

  changed() {
    this.tracks = null;
  }

  // 只改了一首：歌表在内存里就只重读这一首（一两行），不把整张表作废。同步小号一口气发几十首时，
  // 每发一首都整表重读（几千行）会很快用光免费版每天的读取额度
  touched(id) {
    if (!this.tracks) return;
    const r = this.sql.exec('SELECT s.rec, c.mime, c.own FROM songs s LEFT JOIN covers c ON c.id = s.id WHERE s.id = ?', id).toArray()[0];
    const list = this.tracks.filter(t => t.id !== id);
    this.recs.delete(id);
    if (r) {
      const t = this.trackRow(r), at = list.findIndex(x => x.id < id);  // 新的在前
      if (at < 0) list.push(t); else list.splice(at, 0, t);
    }
    this.tracks = list;
  }

  // 歌手热门歌整张表（几百行）读一次记在内存里，每次打开网页、每轮定时任务都不再读库
  hotRows() {
    if (!this.hot) {
      this.hot = new Map(this.sql.exec('SELECT name, songs, retry_at, pic FROM artist_hot').toArray()
        .map(r => [r.name, { songs: JSON.parse(r.songs), retryAt: r.retry_at, pic: r.pic }]));
    }
    return this.hot;
  }

  // { songs: { 歌手: [热门歌名…] }, pics: { 歌手: 照片地址 } }，只给取到了的
  async listHot() {
    const songs = {}, pics = {};
    for (const [name, h] of this.hotRows()) {
      if (h.songs.length) songs[name] = h.songs;
      if (h.pic) pics[name] = h.pic;
    }
    return { songs, pics };
  }

  // 该去网易云取热门歌的歌手：还没取过的、到了该重取的。歌多的歌手先。
  // 只在歌表已经在内存里时才看（有人刚打开过网页、刚发过歌）：定时任务每 5 分钟来一次，DO 多半已经休眠，
  // 为这个把整张歌表读一遍（几千行）一天就是上百万行，会把免费版每天 500 万行的读取额度用光，整个网站都读不了
  async missingHot(n, now) {
    if (!this.tracks) return [];
    const rows = this.hotRows(), count = new Map();
    for (const t of this.tracks) for (const a of artistsOf(t.artist)) count.set(a, (count.get(a) || 0) + 1);
    return [...count].filter(([a]) => !rows.has(a) || rows.get(a).retryAt <= now)
      .sort((x, y) => y[1] - x[1]).slice(0, n).map(([a]) => a);
  }

  // 灰色歌整张表（几百上千行）读一次记在内存里
  async listGrey() {
    if (!this.greyList) this.greyList = this.sql.exec('SELECT info FROM grey ORDER BY at DESC').toArray().map(r => JSON.parse(r.info));
    return this.greyList;
  }

  // → 新记下几首（已经有的更新信息，不算新的）
  async addGrey(list) {
    const known = new Set((await this.listGrey()).map(g => g.sid));
    let fresh = 0;
    for (const g of list) {
      if (!known.has(g.sid)) fresh++;
      known.add(g.sid);
      this.sql.exec(`INSERT INTO grey (sid, info, at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET info = excluded.info`, g.sid, JSON.stringify(g), Date.now());
    }
    if (list.length) this.greyList = null;
    return fresh;
  }

  // pic 为空时留着原来的照片（这次没拿到不等于没有）
  async putHot(name, songs, retryAt, pic = '') {
    const rows = this.hotRows();
    pic = pic || (rows.get(name) || {}).pic || '';
    this.sql.exec(`INSERT INTO artist_hot (name, songs, retry_at, pic) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET songs = excluded.songs, retry_at = excluded.retry_at, pic = excluded.pic`, name, JSON.stringify(songs), retryAt, pic);
    rows.set(name, { songs, retryAt, pic });
  }

  // 歌单里有没有同一首歌（按整理后的歌名、歌手比，时长相差 3 秒以内；时长不知道的也算）
  async findSame(rec) {
    const want = summary(rec);
    const key = norm(want.title) + '|' + norm(want.artist);
    for (const t of await this.listTracks()) {
      if (t.id === rec.id) continue;
      if (norm(t.title) + '|' + norm(t.artist) === key && (!t.duration || !want.duration || Math.abs(t.duration - want.duration) <= 3)) return t.id;
    }
    return null;
  }

  async getTrack(id) {
    const r = this.sql.exec('SELECT rec FROM songs WHERE id = ?', id).toArray()[0];
    return r ? JSON.parse(r.rec) : null;
  }

  // 返回这首是不是第一次登记
  async upsertTrack(rec) {
    const old = await this.getTrack(rec.id);
    // 帖子里换了文件，旧封面、旧歌词、旧音柱数据就作废
    if (!old || old.file_unique_id !== rec.file_unique_id) {
      this.sql.exec('DELETE FROM covers WHERE id = ?', rec.id);
      this.sql.exec('DELETE FROM lyrics WHERE id = ?', rec.id);
      this.sql.exec('DELETE FROM viz WHERE id = ?', rec.id);
    }
    this.sql.exec(`INSERT INTO songs (id, rec, updated) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, updated = excluded.updated`,
      rec.id, JSON.stringify(rec), Date.now());
    this.touched(rec.id);
    return !old;
  }

  // 把这首放到这几个歌单的最前面（已经在里面的不动）。返回真正放进去的歌单名
  async addToPlaylists(id, names) {
    const done = [];
    for (const p of await this.listPlaylists()) {
      if (!names.includes(p.name) || p.tracks.includes(id)) continue;
      this.sql.exec('UPDATE playlists SET tracks = ? WHERE id = ?', JSON.stringify([id, ...p.tracks]), p.id);
      done.push(p.name);
    }
    return done;
  }

  async removeFromPlaylist(id, name) {
    const p = (await this.listPlaylists()).find(x => x.name === name);
    if (!p || !p.tracks.includes(id)) return false;
    this.sql.exec('UPDATE playlists SET tracks = ? WHERE id = ?', JSON.stringify(p.tracks.filter(x => x !== id)), p.id);
    return true;
  }

  async removeTrack(id) {
    this.sql.exec('DELETE FROM songs WHERE id = ?', id);
    this.sql.exec('DELETE FROM covers WHERE id = ?', id);
    this.sql.exec('DELETE FROM lyrics WHERE id = ?', id);
    this.sql.exec('DELETE FROM viz WHERE id = ?', id);
    this.touched(id);
  }

  // 贴网址搬运的设置：每次最多抓几首、放进哪个歌单（空 = 按类型分）。以前存的 sites、licenses 不再用
  async getHarvest() {
    const { limit = 20, playlist = '', channel = '' } = JSON.parse(this.cfg('harvest') || '{}');
    return { limit, playlist, channel };
  }

  async setHarvest(v) { this.setCfg('harvest', JSON.stringify(v)); }

  async getConfig(k) { return this.cfg(k); }

  async setConfig(k, v) { this.setCfg(k, v); }

  // 夜里自动搬的记录：state 是 {频道: 看到的最大消息号}
  async getAuto() {
    return { state: {}, ...JSON.parse(this.cfg('auto') || '{}') };
  }

  async setAuto(v) { this.setCfg('auto', JSON.stringify(v)); }

  // 听众求歌限次：每人每 24 小时最多 ASK_PER_DAY 次（库里直接有的不算）
  async allowAsk(uid, now) {
    this.sql.exec('DELETE FROM asks WHERE at < ?', now - DAY_MS);
    if (this.sql.exec('SELECT COUNT(*) AS n FROM asks WHERE uid = ?', uid).toArray()[0].n >= ASK_PER_DAY) return false;
    this.sql.exec('INSERT INTO asks (uid, at) VALUES (?, ?)', uid, now);
    return true;
  }

  async getSources() {
    return JSON.parse(this.cfg('sources') || '[]');
  }

  async setSources(list) {
    this.setCfg('sources', JSON.stringify(list));
    return list;
  }

  async listPlaylists() {
    return this.sql.exec('SELECT id, name, cover, tracks FROM playlists ORDER BY pos').toArray()
      .map(r => ({ id: r.id, name: r.name, cover: r.cover, tracks: JSON.parse(r.tracks) }));
  }

  // 整体换掉：给的是 [{ id?, name, cover?, tracks }]，没带 id（或 id 不存在）的是新歌单。
  // 中间没有 await，这一串 SQL 不会被别的请求打断，也会一起写进存储
  async setPlaylists(list) {
    const keep = [];
    list.forEach((p, pos) => {
      const args = [pos, p.name, p.cover || 0, JSON.stringify(p.tracks)];
      const hit = Number.isInteger(p.id)
        ? this.sql.exec('UPDATE playlists SET pos = ?, name = ?, cover = ?, tracks = ? WHERE id = ? RETURNING id', ...args, p.id).toArray()[0]
        : null;
      keep.push(hit ? hit.id : this.sql.exec('INSERT INTO playlists (pos, name, cover, tracks) VALUES (?, ?, ?, ?) RETURNING id', ...args).toArray()[0].id);
    });
    this.sql.exec(`DELETE FROM playlists WHERE id NOT IN (${keep.map(() => '?').join(',') || 'NULL'})`, ...keep);
    return this.listPlaylists();
  }

  async getLyrics(id) {
    return this.sql.exec('SELECT src, lrc, retry_at FROM lyrics WHERE id = ?', id).toArray()[0] || null;
  }

  // 自动找到的结果盖不掉手动配的歌词。返回最后存着的那一行
  async putLyrics(id, src, lrc, retryAt) {
    this.sql.exec(`INSERT INTO lyrics (id, src, lrc, retry_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET src = excluded.src, lrc = excluded.lrc, retry_at = excluded.retry_at
      WHERE lyrics.src != 'manual' OR excluded.src = 'manual'`, id, src, lrc, retryAt);
    return this.getLyrics(id);
  }

  // 这张图是不是台标：记下过的，或者已经有 LOGO_MIN_SONGS - 1 首歌用它当封面（同一张专辑的歌共用封面，
  // 不过很少有七八首同专辑的；台标一搬就是几十首）。是的话记下来，用它的歌全部重新配图
  async isLogo(data) {
    if (this.sql.exec('SELECT 1 FROM logo_covers WHERE data = ?', data).toArray().length) return true;
    if (this.sql.exec('SELECT COUNT(*) AS n FROM covers WHERE data = ?', data).toArray()[0].n < LOGO_MIN_SONGS - 1) return false;
    this.markLogo(data);
    return true;
  }

  // 返回受影响的歌有几首（这首没存封面、或者存的是「没有」时为 0）
  // 哪些歌用的是频道图片：语音、确定没有自带缩略图的（thumb 为空字符串）；更早登记、不知道有没有缩略图的，
  // 封面和别的歌一模一样的也算（频道图片是好几首共用的，自带的专辑封面很少重）。返回清掉了几首
  async clearPhotoCovers() {
    const shared = new Set(this.sql.exec(`SELECT data FROM covers WHERE mime != 'none' GROUP BY data HAVING COUNT(*) >= 2`).toArray().map(r => r.data));
    let n = 0;
    for (const r of this.sql.exec("SELECT s.id, s.rec, c.data FROM songs s JOIN covers c ON c.id = s.id WHERE c.mime != 'none'").toArray()) {
      const rec = JSON.parse(r.rec);
      if (rec.kind === 'voice' || rec.thumb === '' || (rec.thumb === undefined && shared.has(r.data))) {
        this.sql.exec('DELETE FROM covers WHERE id = ?', r.id);
        n++;
      }
    }
    this.changed();
    return n;
  }

  async banCover(id) {
    const r = this.sql.exec("SELECT data FROM covers WHERE id = ? AND mime != 'none'", id).toArray()[0];
    if (!r) return 0;
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM covers WHERE data = ?', r.data).toArray()[0].n;
    this.markLogo(r.data);
    return n;
  }

  markLogo(data) {
    this.sql.exec('INSERT OR IGNORE INTO logo_covers (data) VALUES (?)', data);
    this.sql.exec('DELETE FROM covers WHERE data = ?', data);
    this.changed();
  }

  async getViz(id) {
    const r = this.sql.exec('SELECT data FROM viz WHERE id = ?', id).toArray()[0];
    return r ? r.data : null;
  }

  async putViz(id, data) {
    this.sql.exec('INSERT INTO viz (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, data);
  }

  async getCover(id) {
    const r = this.sql.exec('SELECT mime, data, own FROM covers WHERE id = ?', id).toArray()[0];
    if (!r) return null;
    return r.mime === 'none' ? { none: true } : { mime: r.mime, b64: r.data, own: !!r.own };
  }

  // 后台补全：按消息号顺序取接下来 n 首（游标存在 config 的 fillCursor，到头了从头来），挑出还没封面的、
  // 还没找过歌词或到了该再找的。只按主键读这几行，不扫全库（免费版每天读的行数有限）
  async missingArt(n, now) {
    const cursor = Number(this.cfg('fillCursor') || 0);
    let ids = this.sql.exec('SELECT id FROM songs WHERE id > ? ORDER BY id LIMIT ?', cursor, n).toArray().map(r => r.id);
    if (!ids.length && cursor) ids = this.sql.exec('SELECT id FROM songs ORDER BY id LIMIT ?', n).toArray().map(r => r.id);
    this.setCfg('fillCursor', String(ids.length === n ? ids[ids.length - 1] : 0));
    if (!ids.length) return { covers: [], lyrics: [] };
    const marks = ids.map(() => '?').join(',');
    const hasCover = new Set(this.sql.exec(`SELECT id FROM covers WHERE id IN (${marks})`, ...ids).toArray().map(r => r.id));
    const lyr = new Map(this.sql.exec(`SELECT id, retry_at FROM lyrics WHERE id IN (${marks})`, ...ids).toArray().map(r => [r.id, r.retry_at]));
    return {
      covers: ids.filter(id => !hasCover.has(id)),
      lyrics: ids.filter(id => !lyr.has(id) || (lyr.get(id) > 0 && lyr.get(id) <= now)),
    };
  }

  // 封面、歌词各有多少（统计用）
  async artStats(now) {
    const c = this.sql.exec(`SELECT SUM(mime != 'none' AND own = 1) art, SUM(mime != 'none' AND own = 0) photo, SUM(mime = 'none') none,
      (SELECT COUNT(*) FROM songs WHERE id NOT IN (SELECT id FROM covers)) todo FROM covers`).toArray()[0] || {};
    const l = this.sql.exec(`SELECT SUM(src != 'none' AND retry_at = 0) synced, SUM(src != 'none' AND retry_at != 0) plain, SUM(src = 'none') none,
      (SELECT COUNT(*) FROM songs WHERE id NOT IN (SELECT id FROM lyrics)) + COALESCE(SUM(retry_at > 0 AND retry_at <= ?), 0) todo FROM lyrics`, now).toArray()[0] || {};
    return { covers: c, lyrics: l };
  }

  // 补封面：用着频道图片、或记成没有封面的歌清掉封面，下次打开时重新找（会先找网易云的专辑封面）。返回清了几首
  async clearNonArtCovers() {
    this.changed();
    return this.sql.exec("DELETE FROM covers WHERE own = 0 OR mime = 'none'").rowsWritten;
  }

  // 补歌词：确定没有的、只有文字的（手动配的不动），下次打开时马上再找一次。返回几首
  async retryLyrics() {
    return this.sql.exec("UPDATE lyrics SET retry_at = 1 WHERE src != 'manual' AND (src = 'none' OR retry_at > 0)").rowsWritten;
  }

  async putCover(id, mime, data, own = 1) {
    this.sql.exec(`INSERT INTO covers (id, mime, data, own) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, data = excluded.data, own = excluded.own`, id, mime, data, own ? 1 : 0);
    this.touched(id);
  }

  async addPhoto(id, fileId) {
    this.sql.exec('INSERT INTO photos (id, file_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET file_id = excluded.file_id', id, fileId || '');
  }

  async addScannedPhotos(ids) {
    for (const id of ids) this.sql.exec('INSERT OR IGNORE INTO photos (id, file_id) VALUES (?, ?)', id, '');
  }

  async listPhotos() {
    return this.sql.exec('SELECT id, file_id FROM photos').toArray();
  }

  async maxTrackId() {
    const r = this.sql.exec('SELECT MAX(id) AS m FROM songs').toArray()[0];
    return (r && r.m) || 0;
  }

  async getFlag(k) {
    return this.cfg(k) === '1';
  }

  async setFlag(k) {
    this.setCfg(k, '1');
  }

  async importKV(kv) {
    let cursor = null;
    do {
      const page = await kv.list(cursor ? { prefix: 't:', cursor } : { prefix: 't:' });
      for (const k of page.keys) {
        const rec = await kv.get(k.name, 'json');
        if (rec && Number.isInteger(rec.id)) await this.upsertTrack(rec);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }

  cfg(k) {
    const r = this.sql.exec('SELECT v FROM config WHERE k = ?', k).toArray()[0];
    return r ? r.v : null;
  }

  setCfg(k, v) {
    this.sql.exec('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
}


// 歌单里的一行；file_id 只在服务端用，不给出去。
// 这个频道的歌多是从别的频道转来的：表演者一栏常混着转发来源的广告（「更多音乐 @某频道」），
// 标题又常写成「歌手 - 歌名」，这里理成干净的歌名和歌手
function summary(rec) {
  let title = rec.title || '';
  let artist = (rec.performer || '').replace(/@\w+/g, '').replace(/更多音乐/g, '').replace(/\s+/g, ' ').trim();
  const m = !artist && /^(.+?)\s+-\s+(.+)$/.exec(title);
  if (m) {
    artist = m[1].trim();
    title = m[2].trim();
  }
  return {
    id: rec.id, kind: rec.kind, title, artist, mime: rec.mime,
    size: rec.size, duration: rec.duration, date: rec.date,
  };
}

// ── 机器人：频道主私聊管理、听众私聊求歌 ─────────────────────────────

async function tg(env, method, payload) {
  const res = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

function say(env, chatId, textMsg, buttons) {
  const payload = { chat_id: chatId, text: textMsg, disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  return tg(env, 'sendMessage', payload);
}

// 频道主：频道的创建者（问一次 Telegram 就记下来）
async function ownerId(env) {
  const L = lib(env);
  let id = await L.getConfig('ownerId');
  if (!id) {
    const r = await tg(env, 'getChatAdministrators', { chat_id: env.CHANNEL_ID });
    const c = (r.result || []).find(a => a.status === 'creator');
    if (c) await L.setConfig('ownerId', (id = String(c.user.id)));
  }
  return id ? Number(id) : null;
}


async function streamerCall(env, path, body) {
  const res = await fetch(`${streamerBase(env)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Key': env.STREAMER_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(BOT_WAIT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const HELP = `我是小橘音乐的管理助手 🍊 常用的点下面的按钮；左下角「菜单」里也有。全部功能：

🎵 音乐（小橘音乐）
搜 歌名或歌手 —— 去来源频道里找，点按钮就搬
搬 @频道名 100 —— 从这个频道搬 100 首中文歌（查重），搬完告诉你
找 歌名 —— 在小橘音乐里找这首，可以加进/移出歌单、删除
统计 —— 歌库和这几天搬歌的情况
进度 —— 正在搬的活做到哪了（同步小号、往频道发歌、抓网址、从频道搬歌）
灰色歌 —— 网易云上没有音源（没版权、下架、要单独购买）的歌：不下载，只记信息，网页上灰色显示；发这个要一份 txt 清单
贴网易云主页链接（歌手主页、音乐人的用户主页） —— 记成小号：它热门前 50 首里库里没有的，不用你过目，直接发进频道（和小橘视频的小号一样）
小号 —— 看加了哪些小号；「同步小号」现在把所有小号抓一遍；「删除小号 2」删第 2 个；每天凌晨 3 点自动同步
贴专辑、歌单、单曲链接 —— 抓里面的歌，先列给你过目，确认是我们的歌点通过才发进频道；专辑、歌单会先告诉你一共几首、已有几首，点按钮选抓多少；后面直接加数量就不问了，比如「网址 30」
爬 歌名或歌手 —— 不用网址，直接去网易云搜着抓，一样先列给你过目；可以加数量，比如「爬 小橘 30」
搬运设置 —— 每次抓几首、搬到哪个歌单、先发到测试频道还是正式频道
网易云登录 —— 扫码登录小橘音乐的网易云会员账号，VIP 歌才下得到；会员过期了续上再发一次
补封面 / 补歌词 —— 没有专辑封面、没有歌词的歌重新找一遍（封面先找网易云的专辑图）
自检 —— 查网易云登录、试下载小号的歌、看频道能不能发帖（每小时也自动查，结果在「搬运设置」里）
直接发歌名 —— 和听众一样找这首歌，库里没有就自动搬进来（新歌按类型自动进歌单）
`;


const PUBLIC_HELP = `你好，这里是小橘音乐 🍊
发一个歌名给我（可以加上歌手名），我帮你找。找到了会给你一个链接，点开就能听。`;

const tooLong = s => s.length > 60;
// 频道主的菜单：输入框下面常驻的按钮（点了等于发对应的文字），和左下角「菜单」里的 / 命令
const OWNER_KEYBOARD = {
  keyboard: [['📈 统计', '⏳ 进度'], ['👥 小号', '🔄 同步小号'], ['⬜ 灰色歌', '🩺 自检'], ['🔑 网易云登录', '🎵 搬运设置'], ['❓ 帮助']],
  resize_keyboard: true, is_persistent: true,
};

const OWNER_COMMANDS = [
  ['stats', '📈 歌库和搬歌统计'],
  ['tasks', '⏳ 正在搬的进度'],
  ['alts', '👥 小号列表'],
  ['sync', '🔄 同步小号（新歌直接发）'],
  ['grey', '⬜ 灰色歌清单（没有音源的）'],
  ['check', '🩺 自检（网易云登录、下载、发帖）'],
  ['login', '🔑 网易云登录（扫码）'],
  ['harvest', '🎵 搬运设置'],
  ['help', '❓ 全部功能'],
];

const OWNER_ALIAS = {
  '📈 统计': '统计', '⏳ 进度': '进度', '👥 小号': '小号', '🔄 同步小号': '同步小号', '⬜ 灰色歌': '灰色歌',
  '🩺 自检': '自检', '🔑 网易云登录': '网易云登录', '🎵 搬运设置': '搬运设置', '❓ 帮助': '帮助',
  '/stats': '统计', '/tasks': '进度', '/alts': '小号', '/sync': '同步小号', '/grey': '灰色歌',
  '/check': '自检', '/login': '网易云登录', '/harvest': '搬运设置',
};

const COMMANDS_VERSION = '6';
// 按钮变了，菜单（/ 命令）自动重设；输入框下面的常驻按钮要随一条消息发过去才会换，所以顺带说一句
const COMMANDS_NEWS = '按钮更新了：多了「🔄 同步小号」「⬜ 灰色歌」「🩺 自检」「🔑 网易云登录」，点一下就行，不用打字。';


// 频道主的「菜单」命令只设给频道主自己看（听众那边不变）；版本变了才重设
async function ensureOwnerCommands(env, owner) {
  const L = lib(env);
  if ((await L.getConfig('cmdsVer')) === COMMANDS_VERSION) return;
  const r = await tg(env, 'setMyCommands', {
    commands: OWNER_COMMANDS.map(([command, description]) => ({ command, description })),
    scope: { type: 'chat', chat_id: owner },
  });
  if (!r.ok) return;
  await L.setConfig('cmdsVer', COMMANDS_VERSION);
  await tg(env, 'sendMessage', { chat_id: owner, text: COMMANDS_NEWS, reply_markup: OWNER_KEYBOARD });
}

function ownerHelp(env, chat) {
  return tg(env, 'sendMessage', { chat_id: chat, text: HELP, disable_web_page_preview: true, reply_markup: OWNER_KEYBOARD });
}

async function botUpdate(env, update, origin) {
  const owner = await ownerId(env);
  if (update.callback_query) return botButton(env, update.callback_query, owner, origin);
  const m = update.message;
  const chat = m.chat.id, isOwner = owner && m.from && m.from.id === owner;
  let t = (m.text || '').trim();
  if (isOwner) {
    try { await ensureOwnerCommands(env, owner); } catch {}
    t = t.replace(/^(\/\w+)@\w+/, '$1');  // 群里点菜单会带 @机器人名
    t = OWNER_ALIAS[t] || t;
  }
  if (!t || /^\/(start|help)\b/.test(t) || t === '帮助') return isOwner ? ownerHelp(env, chat) : say(env, chat, PUBLIC_HELP);
  if (isOwner) {
    let c;
    if ((c = /^搜\s*(.+)$/.exec(t))) return ownerSearch(env, chat, c[1].trim());
    if ((c = /^搬\s*@?(\w{4,64})(?:\s+(\d{1,4}))?\s*(?:首)?$/.exec(t))) return ownerCopy(env, chat, c[1], Number(c[2] || 50));
    if ((c = /^找\s*(.+)$/.exec(t))) return ownerFind(env, chat, c[1].trim(), origin);
    if (/^(统计|今天搬了多少|搬了多少)/.test(t)) return ownerStats(env, chat);
    if (/^(进度|搬到哪了|同步进度)$/.test(t)) return ownerProgress(env, chat);
    if (/^灰色歌(曲|单)?$/.test(t)) {
      try { await pullGrey(env); } catch {}  // 先把流式服务刚记下的取过来（取不到就用存着的）
      return sendGreyFile(env, chat, 0, true);
    }
    if ((c = /^爬\s*(.*?)(?:\s+(\d{1,3})\s*首?)?$/.exec(t))) {
      if (!c[1]) return say(env, chat, '爬什么？发「爬 歌名或歌手」，比如「爬 小橘 30」');
      return ownerHarvest(env, chat, { query: c[1].slice(0, 60) }, c[2] ? Number(c[2]) : 0, origin);
    }
    if ((c = /(https?:\/\/\S+)(?:\s+(\d{1,3}))?/.exec(t))) return ownerLink(env, chat, c[1], c[2] ? Number(c[2]) : 0, origin);
    if (t === '小号') return say(env, chat, await altsText(env));
    if (t === '自检') {
      if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
      await say(env, chat, '自检中：查网易云登录、试下载小号热门歌、看频道能不能发帖……');
      let h;
      try { h = await selfCheck(env, true); } catch { h = null; }
      if (!h || h.login === undefined) return say(env, chat, '搬运服务正在唤醒，过一两分钟再发「自检」');
      return say(env, chat, healthLines(h).join('\n'));
    }
    if (t === '补封面') {
      const n = await lib(env).clearNonArtCovers();
      listCache = null;
      return say(env, chat, `好的，${n} 首没有专辑封面的歌（用着频道图片的、或之前没找到的）后台重新找：先找网易云的专辑封面，找不到再配频道图片。每分钟补一批，不用等人打开；发「统计」看还剩多少。`);
    }
    if (t === '补歌词') {
      const n = await lib(env).retryLyrics();
      return say(env, chat, `好的，${n} 首没歌词或只有文字的歌，后台再去 LRCLIB、网易云找一次（手动配的不动）。每分钟补一批，不用等人打开；发「统计」看还剩多少。`);
    }
    if (t === '同步小号') {
      const alts = await getAlts(env);
      if (!alts.length) return say(env, chat, '还没加小号：把小号的网易云主页链接发给我。');
      return syncAlts(env, chat, alts);
    }
    if ((c = /^删除小号\s*(\d+)$/.exec(t))) return deleteAlt(env, chat, Number(c[1]));
    if (/^搬运设置$/.test(t)) return showHarvest(env, chat);
    if ((c = /^搬运数量\s*(\d{1,3})$/.exec(t))) return setHarvestLimit(env, chat, Number(c[1]));
    if ((c = /^搬运歌单\s*(.+)$/.exec(t))) return setHarvestPlaylist(env, chat, c[1].trim());
    if ((c = /^搬运频道\s*(.+)$/.exec(t))) return setHarvestChannel(env, chat, c[1].trim());
    if (/^网易云登录$/.test(t)) return neteaseLogin(env, chat);
  }
  if (tooLong(t)) return say(env, chat, '歌名太长啦，发短一点（歌名，或者「歌名 歌手」）');
  return songRequest(env, chat, m.from ? m.from.id : chat, t, origin, isOwner);
}


// 在小橘音乐里按歌名、歌手找（不分大小写、去掉符号）
async function libraryFind(env, q, n = 5) {
  const nq = norm(q);
  if (!nq) return [];
  const scored = [];
  for (const t of await lib(env).listTracks()) {
    const nt = norm(t.title), na = norm(t.artist);
    let s = 0;
    if (nt === nq) s = 100;
    else if (na && nt && nq.includes(nt) && nq.includes(na)) s = 95;
    else if (nt.includes(nq)) s = 60;
    else if ((nt + na).includes(nq)) s = 40;
    if (s) scored.push([s, t]);
  }
  return scored.sort((a, b) => b[0] - a[0] || b[1].id - a[1].id).slice(0, n).map(x => x[1]);
}

const nameOf = t => (t.artist ? `${t.artist} - ${t.title}` : t.title);

async function songRequest(env, chat, uid, q, origin, isOwner) {
  const hit = (await libraryFind(env, q, 1))[0];
  if (hit && norm(hit.title).length >= Math.min(2, norm(q).length)) {
    return say(env, chat, `🎵 小橘音乐里有：${nameOf(hit)}\n点这里听：${origin}/#${hit.id}`);
  }
  if (!isOwner && !(await lib(env).allowAsk(uid, Date.now()))) {
    return say(env, chat, '今天帮你找的歌有点多啦，明天再来吧 🙏');
  }
  if (!streamerOn(env)) return say(env, chat, `小橘音乐里还没有「${q}」`);
  await say(env, chat, `小橘音乐里还没有「${q}」，我去找找，稍等一会儿…`);
  try {
    const L = lib(env);
    const { status } = await streamerCall(env, '/fulfill', {
      q, chat_id: chat, only: await L.getSources(), link: origin + '/',
      existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    });
    if (status !== 200) throw new Error(String(status));
  } catch {
    await say(env, chat, '找歌的服务正在睡觉（刚被叫醒），过一两分钟再发一次歌名试试');
  }
}

async function ownerSearch(env, chat, q) {
  if (!streamerOn(env)) return say(env, chat, '搬歌服务没配置');
  const only = (await lib(env).getSources()).join(',');
  let res;
  try {
    const r = await fetch(`${streamerBase(env)}/search/global?q=${encodeURIComponent(q)}&only=${encodeURIComponent(only)}&limit=150`, {
      headers: { 'X-Key': env.STREAMER_KEY }, signal: AbortSignal.timeout(BOT_WAIT_MS),
    });
    res = ((await r.json().catch(() => ({}))).results || []);
  } catch {
    return say(env, chat, '搬歌服务正在唤醒，过一两分钟再搜一次');
  }
  res = res.filter(r => r.duration >= 60).slice(0, 8);
  if (!res.length) return say(env, chat, `来源频道里没搜到「${q}」`);
  const lines = res.map((r, i) => `${i + 1}. ${r.performer ? r.performer + ' - ' : ''}${r.title}（${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}，@${r.channel}）`);
  const buttons = [];
  for (let i = 0; i < res.length; i += 4) {
    buttons.push(res.slice(i, i + 4).map((r, k) => ({ text: `搬 ${i + k + 1}`, callback_data: `p:${r.channel}:${r.id}` })));
  }
  return say(env, chat, `搜「${q}」找到这些，点按钮搬进来：\n` + lines.join('\n'), buttons);
}

async function ownerCopy(env, chat, source, n) {
  if (!streamerOn(env)) return say(env, chat, '搬歌服务没配置');
  const L = lib(env);
  try {
    const { status } = await streamerCall(env, '/copy/start', {
      source, limit: Math.max(1, Math.min(n, 500)), min_seconds: 60, max_seconds: 1200, chinese_only: true,
      notify: chat, existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    });
    if (status === 409) return say(env, chat, '正在搬别的，等那边搬完再来（搬完会通知你）');
    if (status !== 200) throw new Error(String(status));
  } catch {
    return say(env, chat, '搬歌服务正在唤醒，过一两分钟再发一次');
  }
  return say(env, chat, `开始从 @${source} 搬最多 ${n} 首中文歌，搬完告诉你 👌`);
}

async function ownerFind(env, chat, q, origin) {
  const hits = await libraryFind(env, q, 5);
  if (!hits.length) return say(env, chat, `小橘音乐里没有「${q}」。想从来源频道找的话发：搜 ${q}`);
  const pls = await lib(env).listPlaylists();
  for (const t of hits) {
    const inside = pls.filter(p => p.tracks.includes(t.id)).map(p => p.name);
    await say(env, chat, `${nameOf(t)}\n${inside.length ? '在歌单：' + inside.join('、') : '不在任何歌单'}\n${origin}/#${t.id}`, [[
      { text: '加入歌单', callback_data: `a:${t.id}` },
      { text: '移出歌单', callback_data: `r:${t.id}` },
      { text: '删除', callback_data: `d:${t.id}` },
    ]]);
  }
}

async function ownerStats(env, chat) {
  const L = lib(env);
  const tracks = await L.listTracks();
  const now = Date.now() / 1000;
  const recent = d => tracks.filter(t => t.date > now - d * 86400).length;
  const auto = await L.getAuto();
  const lines = [`歌库一共 ${tracks.length} 首`, `最近 24 小时新增 ${recent(1)} 首，7 天 ${recent(7)} 首`];
  const { covers: c, lyrics: w } = await L.artStats(Date.now());
  lines.push(`封面：专辑图 ${c.art || 0} 首，频道图片 ${c.photo || 0} 首，没有 ${c.none || 0} 首` + (c.todo ? `，还有 ${c.todo} 首在后台找` : ''));
  lines.push(`歌词：带时间轴 ${w.synced || 0} 首，只有文字 ${w.plain || 0} 首，没有 ${w.none || 0} 首` + (w.todo ? `，还有 ${w.todo} 首在后台找` : ''));
  if (auto.lastStart) lines.push(`上次夜里自动搬：${auto.lastStart.slice(0, 10)}${auto.lastCopied != null ? `，搬了 ${auto.lastCopied} 首` : ''}`);
  lines.push('', '各歌单：', ...(await L.listPlaylists()).map(p => `· ${p.name} ${p.tracks.length} 首`));
  return say(env, chat, lines.join('\n'));
}

// 「进度」：问流式服务正在搬的活做到哪了（贴网址抓歌 / 发审核通过的 / 同步小号，和从频道搬歌各一单）。
// 这两个状态只在流式服务的内存里，它重启过就是「没在搬」
async function ownerProgress(env, chat) {
  if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
  let h, c;
  try {
    [h, c] = await Promise.all([streamerCall(env, '/harvest/status'), streamerCall(env, '/copy/status')]);
  } catch {
    return say(env, chat, '搬运服务正在唤醒，过一两分钟再发「进度」');
  }
  if (h.status !== 200 && c.status !== 200) return say(env, chat, '搬运服务正在唤醒，过一两分钟再发「进度」');
  try { await pullGrey(env); } catch {}  // 顺手把新记下的灰色歌取过来
  const lines = [harvestProgress(h.status === 200 ? h.data : null), copyProgress(c.status === 200 ? c.data : null)].filter(Boolean);
  return say(env, chat, lines.length ? lines.join('\n\n') : '现在没有在搬的活。（搬运服务重启过的话，之前那单的记录也没了）');
}

// 流式服务 Harvester 的状态 → 一段话。kind：direct 同步小号 / post 发审核通过的 / crawl 抓网址、爬关键词
function harvestProgress(h) {
  if (!h || !h.kind || h.status === 'idle') return '';
  const n = (h.results || []).length;
  const alts = (h.alts || []).filter(Boolean);
  const what = h.kind === 'direct' ? `同步小号${alts.length ? `「${alts.join('、')}」` : ''}`
    : h.kind === 'post' ? '把审核通过的歌发进频道'
    : h.query ? `在${h.site || '网站'}搜「${h.query}」` : `抓网址里的歌（${h.site || ''}）`;
  const posting = h.kind === 'direct' || h.kind === 'post';
  const have = h.have ? `；${h.have} 首库里已有，不发` : '';
  if (h.status === 'running') {
    if (h.kind === 'direct' && !h.total) return `🔄 正在${what}：在看热门前 50 首，找库里没有的${have}`;
    if (posting) return `🔄 正在${what}：${h.total} 首新歌，已发 ${h.copied} 首，处理到第 ${n} 首${have}`;
    return `🔄 正在${what}：已经看了 ${n} 首，抓完发审核单给你`;
  }
  const end = h.status === 'error' ? `出错停了（${h.error || '原因不明'}）` : h.status === 'stopped' ? '被停掉了' : '已经做完';
  const tail = posting ? `，发了 ${h.copied || 0} 首${h.total > h.copied ? `，没发 ${h.total - h.copied} 首` : ''}${have}`
    : h.kind === 'crawl' && h.review ? `，${h.review} 首进了审核单` : '';
  return `✅ 上一单（${what}）${end}${tail}`;
}

// 流式服务 Copier 的状态（从来源频道搬歌、夜里自动搬）→ 一段话；没在跑就不说
function copyProgress(c) {
  if (!c || c.status !== 'running') return '';
  const what = c.mode === 'auto' ? '夜里自动搬' : `从 @${c.source || '来源频道'} 搬歌`;
  const skipped = (c.skipped_dup || 0) + (c.skipped_lang || 0) + (c.skipped_other || 0);
  return `🔄 正在${what}：看了 ${c.scanned || 0} 首，搬了 ${c.copied || 0} 首` + (skipped ? `，跳过 ${skipped} 首` : '') +
    (c.waiting ? `（Telegram 限流，等 ${c.waiting} 秒）` : '');
}

async function botButton(env, cb, owner, origin) {
  const chat = cb.message && cb.message.chat.id;
  const ack = textMsg => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: textMsg || '' });
  if (!owner || !cb.from || cb.from.id !== owner) return ack('只有频道主能用');
  const [kind, a, b] = String(cb.data || '').split(':');
  const L = lib(env);
  if (kind === 'hv') return harvestDecide(env, cb, a === 'ok', ack);
  if (kind === 'hk') { // 数完歌，按了「抓 N 首」
    const ask = JSON.parse((await L.getConfig('harvestAsk')) || '{}');
    if (!ask.url) return ack('这条过期了，重新发一次网址');
    await ack();
    if (cb.message) await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    return ownerHarvest(env, chat, { url: ask.url }, Number(a) || 0, origin);
  }
  if (kind === 'p') { // 搬搜到的那首
    await ack('搬运中…');
    try {
      const { data } = await streamerCall(env, '/copy/pick', { items: [{ channel: a, id: Number(b) }] });
      const id = (data.new_ids || [])[0];
      return say(env, chat, id ? `✅ 搬好了，会自动放进对应的歌单：${origin}/#${id}` : '⛔ 这首搬不了（可能那个频道禁止转发）');
    } catch {
      return say(env, chat, '搬歌服务正在唤醒，过一两分钟再点一次');
    }
  }
  const id = Number(a);
  const t = (await L.listTracks()).find(x => x.id === id);
  if (!t) return ack('这首已经不在了');
  const pls = await L.listPlaylists();
  if (kind === 'a') {
    await ack();
    const opts = pls.filter(p => !p.tracks.includes(id));
    if (!opts.length) return say(env, chat, '已经在所有歌单里了');
    return say(env, chat, `把「${t.title}」加到哪个歌单？`, rows(opts.map(p => ({ text: p.name, callback_data: `ap:${id}:${p.id}` }))));
  }
  if (kind === 'r') {
    await ack();
    const opts = pls.filter(p => p.tracks.includes(id));
    if (!opts.length) return say(env, chat, '它不在任何歌单里');
    return say(env, chat, `把「${t.title}」从哪个歌单移出？`, rows(opts.map(p => ({ text: p.name, callback_data: `rp:${id}:${p.id}` }))));
  }
  if (kind === 'ap' || kind === 'rp') {
    const p = pls.find(x => x.id === Number(b));
    if (!p) return ack('歌单不在了');
    if (kind === 'ap') await L.addToPlaylists(id, [p.name]); else await L.removeFromPlaylist(id, p.name);
    listCache = null;
    await ack(kind === 'ap' ? `已加入「${p.name}」` : `已移出「${p.name}」`);
    return say(env, chat, `${kind === 'ap' ? '✅ 已加入' : '✅ 已移出'}「${p.name}」：${nameOf(t)}`);
  }
  if (kind === 'd') {
    await ack();
    return say(env, chat, `确定从小橘音乐删除「${nameOf(t)}」吗？（频道里的帖子不动）`, [[
      { text: '确定删除', callback_data: `dd:${id}` }, { text: '算了', callback_data: 'x:0' },
    ]]);
  }
  if (kind === 'dd') {
    await L.removeTrack(id);
    forget(id);
    await ack('已删除');
    return say(env, chat, `🗑 已删除：${nameOf(t)}`);
  }
  return ack();
}


// ── 贴网址搬自己的歌（真正干活的在流式服务的 harvest/ 里：网站适配器、审核单、上传） ──
// 抓取只是把歌放进审核单：流式服务凑成一张发给频道主（和小橘视频的审核单一样，整批「通过 / 失败」），通过了才发进频道
const HARVEST_SITES = { netease: '网易云音乐' };

function harvestPanel(h, env, ne = {}) {
  return {
    text: [
      '搬运设置', '',
      `每次最多抓：${h.limit} 首（发「搬运数量 30」改）`,
      `搬到歌单：${h.playlist || '按类型自动分'}（发「搬运歌单 纯音乐」或「搬运歌单 自动」改）`,
      `网易云账号：${ne.cookie ? `${ne.nickname || '已登录'}（${new Date(ne.at).toISOString().slice(0, 10)} 登录；VIP 歌下不了就发「网易云登录」重新扫码）` : '没登录，VIP 歌下不了（发「网易云登录」扫码）'}`,
      `发到频道：${h.channel ? `测试频道 @${h.channel}（不进小橘音乐；发「搬运频道 正式」改回）` : `正式频道「小橘🍊音乐」（发「搬运频道 @测试频道」先发去试）`}`, '',
      `支持：${Object.values(HARVEST_SITES).join('、')}（贴网址，或发「爬 歌名或歌手」去上面搜）。抓到的全部进审核单，你确认是我们自己的歌点「审核通过」才发进频道。`,
    ].join('\n'),
  };
}

async function showHarvest(env, chat) {
  const p = harvestPanel(await lib(env).getHarvest(), env, await neteaseAccount(env));
  p.text += '\n\n' + healthLines(JSON.parse((await lib(env).getConfig('health')) || '{}')).join('\n');
  return tg(env, 'sendMessage', { chat_id: chat, ...p, disable_web_page_preview: true });
}

async function setHarvestLimit(env, chat, n) {
  const L = lib(env), h = await L.getHarvest();
  h.limit = Math.max(1, Math.min(n, 200));
  await L.setHarvest(h);
  return say(env, chat, `好的，以后每次最多搬 ${h.limit} 首`);
}

// 网易云登录：流式服务发二维码给频道主，扫完 cookie 留在它那里；Worker 要用时（neteaseAccount）去取，存进 config
// （流式服务推不过来：Hugging Face 的机房挡掉了 *.workers.dev）。cookie 不出现在任何响应里
async function neteaseLogin(env, chat) {
  if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
  let r;
  try {
    r = await streamerCall(env, '/netease/login', { notify: chat });
  } catch {
    r = { status: 0 };
  }
  if (r.status !== 200) return say(env, chat, '搬运服务正在唤醒，过一两分钟再发一次「网易云登录」');
  return say(env, chat, '网易云登录二维码马上发给你，用网易云 App 扫码确认（用小橘音乐的会员账号）');
}

// 存着的网易云账号 {cookie, nickname, at}；流式服务那里有更新的（刚扫码登录）就换成那个。流式服务在睡就用存着的
async function neteaseAccount(env) {
  const L = lib(env);
  const saved = JSON.parse((await L.getConfig('netease')) || '{}');
  if (!streamerOn(env)) return saved;
  try {
    const r = await streamerCall(env, '/netease/session');
    const n = r.data || {};
    if (r.status === 200 && typeof n.cookie === 'string' && n.cookie && n.cookie.length < 8000 && Number(n.at) > (saved.at || 0)) {
      const fresh = { cookie: n.cookie, nickname: String(n.nickname || '').slice(0, 64), at: Number(n.at) };
      await L.setConfig('netease', JSON.stringify(fresh));
      return fresh;
    }
  } catch {}
  return saved;
}

// 审核通过的歌发到哪：测试频道（频道主账号要是那里的管理员；Worker 只登记正式频道的帖子，测试的不进小橘音乐）或正式频道
async function setHarvestChannel(env, chat, name) {
  const L = lib(env), h = await L.getHarvest();
  if (name === '正式') {
    h.channel = '';
    await L.setHarvest(h);
    return say(env, chat, `好的，审核通过的歌发进正式频道「小橘🍊音乐」`);
  }
  const m = /^(?:@|https?:\/\/t\.me\/)?(\w{4,64})$/.exec(name);
  if (!m) return say(env, chat, '频道名不对：发「搬运频道 @频道用户名」，或「搬运频道 正式」');
  if (m[1].toLowerCase() === String(env.CHANNEL_USERNAME).toLowerCase()) return setHarvestChannel(env, chat, '正式');
  h.channel = m[1];
  await L.setHarvest(h);
  return say(env, chat, `好的，审核通过的歌先发到测试频道 @${m[1]}，不进小橘音乐。频道主账号要是那个频道的管理员。试好了发「搬运频道 正式」改回来`);
}

async function setHarvestPlaylist(env, chat, name) {
  const L = lib(env), h = await L.getHarvest();
  if (name === '自动') {
    h.playlist = '';
    await L.setHarvest(h);
    return say(env, chat, '好的，搬来的歌按类型自动分进歌单');
  }
  if (name.length > 40) return say(env, chat, '歌单名太长了');
  const pls = await L.listPlaylists();
  let made = false;
  if (!pls.some(p => p.name === name)) { // 没有这个歌单就新建一个，排在最后
    await L.setPlaylists([...pls.map(p => ({ id: p.id, name: p.name, cover: p.cover, tracks: p.tracks })), { name, tracks: [] }]);
    listCache = null;
    made = true;
  }
  h.playlist = name;
  await L.setHarvest(h);
  return say(env, chat, `好的，搬来的歌都放进「${name}」${made ? '（新建了这个歌单）' : ''}`);
}

// what：{url} 抓这个网址里的歌，或 {query} 去网站上按关键词搜
async function ownerHarvest(env, chat, what, n, origin) {
  if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
  const L = lib(env), settings = await L.getHarvest();
  if (n) settings.limit = Math.max(1, Math.min(n, 200));
  let r;
  try {
    r = await streamerCall(env, '/harvest', {
      ...what, settings: { ...settings, sites: Object.keys(HARVEST_SITES) }, notify: chat, link: origin,
      existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    });
  } catch {
    return say(env, chat, `搬运服务正在唤醒，过一两分钟再发一次${what.query ? '' : '网址'}`);
  }
  if (r.status === 400) {
    const why = r.data.detail || '这个网址搬不了';
    return say(env, chat, `${why}。${/不支持/.test(why) ? '现在支持：' + Object.values(HARVEST_SITES).join('、') + '。想加别的网站跟我说。' : ''}`);
  }
  if (r.status === 409) {
    const busy = r.data.detail && r.data.detail.busy;
    if (!busy) return say(env, chat, '搬运服务正在启动，过一两分钟再发一次');
    return say(env, chat, `上一单还没做完：${busy}。一次只做一单（抓 → 审核 → 发），做完会通知你，到时再发这个${what.query ? '' : '网址'}。`);
  }
  if (r.status !== 200) return say(env, chat, `搬运服务正在唤醒，过一两分钟再发一次${what.query ? '' : '网址'}`);
  const where = r.data.site || '这个网站';
  return say(env, chat, `${what.query ? `开始在${where}搜「${what.query}」` : `开始从${where}抓`}，最多 ${settings.limit} 首。抓完发审核单给你，确认是我们的歌点通过才发进频道 👌`);
}

// ── 小号：频道主发的网易云主页（歌手主页、音乐人的用户主页）。和小橘视频的小号一样：新歌不用审核，直接发进频道 ──
// config 的 neteaseAlts：[{id（歌手编号）, name, url, at}]

async function getAlts(env) {
  return JSON.parse((await lib(env).getConfig('neteaseAlts')) || '[]');
}

async function altsText(env) {
  const alts = await getAlts(env);
  if (!alts.length) return '还没加小号。把小号的网易云主页链接（歌手主页，或音乐人的用户主页）发给我就加上。';
  return ['你的小号（热门前 50 首里库里没有的，不用审核，直接发进频道）：',
    ...alts.map((a, i) => `${i + 1}. ${a.name || '歌手 ' + a.id}\n   ${a.url}`),
    '', '「同步小号」现在抓一遍；「删除小号 2」删第 2 个；每天凌晨 3 点自动同步'].join('\n');
}

async function deleteAlt(env, chat, n) {
  const alts = await getAlts(env);
  const [gone] = alts.splice(n - 1, 1);
  if (!gone) return say(env, chat, '没有这个编号，发「小号」看列表。');
  await lib(env).setConfig('neteaseAlts', JSON.stringify(alts));
  return say(env, chat, `删掉了小号「${gone.name || gone.id}」，以后不再抓它。已经发进频道的不动。`);
}

// 同步这些小号：交给流式服务，新歌直接发（发到搬运设置里的频道，默认正式频道），发完它私聊频道主
async function syncAlts(env, chat, alts) {
  if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
  const L = lib(env), h = await L.getHarvest();
  let r;
  try {
    r = await streamerCall(env, '/harvest/alts', {
      alts: alts.map(a => ({ url: a.url, name: a.name })), settings: { ...h, sites: Object.keys(HARVEST_SITES) },
      existing: (await L.listTracks()).map(t => [t.title, t.artist]), notify: chat,
      channel: h.channel, cookie: (await neteaseAccount(env)).cookie || '',
    });
  } catch {
    r = { status: 0, data: {} };
  }
  await altHot(env, alts);
  const names = alts.map(a => a.name || a.id).join('、');
  if (r.status === 200) {
    return say(env, chat, `开始同步小号「${names}」：每个号看热门前 50 首，库里没有的直接发进${h.channel ? `测试频道 @${h.channel}` : '频道'}，不用审核，发完告诉你。中途想看做到哪了，发「进度」。`);
  }
  if (r.status === 409 && r.data.detail && r.data.detail.busy) {
    return say(env, chat, `上一单还没做完：${r.data.detail.busy}。做完会通知你，到时发「同步小号」。`);
  }
  if (r.status === 400) return say(env, chat, `同步不了：${r.data.detail || '网址不对'}`);
  return say(env, chat, '搬运服务正在唤醒，过一两分钟再发「同步小号」');
}

// 频道主贴了一个网址：主页 → 记成小号并马上同步；专辑、歌单（没写数量）→ 先数一数；其他 → 抓了出审核单
async function ownerLink(env, chat, url, n, origin) {
  if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
  const settings = await lib(env).getHarvest();
  let r;
  try {
    r = await streamerCall(env, '/harvest/describe', { url, settings: { ...settings, sites: Object.keys(HARVEST_SITES) } });
  } catch {
    return say(env, chat, '搬运服务正在唤醒，过一两分钟再发一次网址');
  }
  if (r.status === 400) return ownerHarvest(env, chat, { url }, n, origin);  // 不支持之类：原样走一遍，报同样的原因
  if (r.status !== 200) return say(env, chat, r.status === 409 ? '搬运服务正在启动，过一两分钟再发一次' : '搬运服务正在唤醒，过一两分钟再发一次网址');
  const d = r.data || {};
  if (d.kind === 'artist' && d.id) {
    const L = lib(env), alts = await getAlts(env);
    let alt = alts.find(a => String(a.id) === String(d.id));
    const fresh = !alt;
    if (fresh) {
      alt = { id: String(d.id), name: d.name || '', url: `https://music.163.com/artist?id=${d.id}`, at: Date.now() };
      alts.push(alt);
      await L.setConfig('neteaseAlts', JSON.stringify(alts));
    }
    await say(env, chat, fresh ? `👥 加了小号「${alt.name || alt.id}」（第 ${alts.length} 个）。以后它热门前 50 首里库里没有的，不用审核，直接发进频道。` : `👥 「${alt.name || alt.id}」已经是小号了，现在同步一遍。`);
    return syncAlts(env, chat, [alt]);
  }
  if (n || d.kind === 'song') return ownerHarvest(env, chat, { url }, n, origin);
  return harvestCount(env, chat, url, origin);
}

// 贴了专辑、歌单、歌手主页、用户主页的网址（没写数量）：先请流式服务数一数一共几首、库里已有几首，按按钮再抓。
// 单曲直接抓；数不了（服务在睡、太慢）就照旧直接抓
const KIND_NAME = { album: '专辑', playlist: '歌单', artist: '歌手主页' };

async function harvestCount(env, chat, url, origin) {
  if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
  const L = lib(env), settings = await L.getHarvest();
  let r;
  try {
    r = await streamerCall(env, '/harvest/count', {
      url, settings: { ...settings, sites: Object.keys(HARVEST_SITES) },
      existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    });
  } catch {
    return ownerHarvest(env, chat, { url }, 0, origin);
  }
  if (r.status === 400) return ownerHarvest(env, chat, { url }, 0, origin);  // 网址不支持之类：原样走一遍，报同样的原因
  const d = r.data || {};
  if (r.status !== 200 || !KIND_NAME[d.kind]) return ownerHarvest(env, chat, { url }, 0, origin);
  const left = d.total - d.have;
  const head = `${KIND_NAME[d.kind]}${d.name ? `「${d.name}」` : ''}：一共 ${d.total} 首${d.total >= 1000 ? '（只数了前 1000 首）' : ''}，小橘音乐里已有 ${d.have} 首，没搬的 ${left} 首。`;
  if (!left) return say(env, chat, `${head}\n都搬过了 👌`);
  await L.setConfig('harvestAsk', JSON.stringify({ url, at: Date.now() }));
  const all = Math.min(left, 200);
  const buttons = [{ text: `抓 ${Math.min(settings.limit, all)} 首`, callback_data: `hk:${Math.min(settings.limit, all)}` }];
  if (all > settings.limit) buttons.push({ text: left > 200 ? '抓 200 首（一次最多）' : `全部 ${all} 首`, callback_data: `hk:${all}` });
  return say(env, chat, `${head}\n要抓多少？抓到的照样先进审核单，确认是我们的歌再发。也可以发「网址 数量」自己定。`, [buttons]);
}

// 频道主按了审核单的按钮：交给流式服务，通过的开始发；审核单改成审过的样子、去掉按钮
async function harvestDecide(env, cb, ok, ack) {
  const id = String(cb.data).split(':')[2];
  if (!streamerOn(env)) return ack('搬运服务没配置');
  let r;
  try {
    r = await streamerCall(env, '/harvest/review', {
      id, ok, notify: cb.from.id, channel: (await lib(env).getHarvest()).channel,
      cookie: ok ? (await neteaseAccount(env)).cookie || '' : '',
      existing: (await lib(env).listTracks()).map(t => [t.title, t.artist]),
    });
  } catch {
    return ack('搬运服务正在唤醒，过一两分钟再点');
  }
  const { result, count } = r.data || {};
  if (r.status !== 200 || !result) return ack('搬运服务正在唤醒，过一两分钟再点');
  if (result === 'busy') return ack(`上一单还没做完：${r.data.busy || '正在抓或发'}，做完再点`.slice(0, 190));
  const line = {
    approved: `✅ 审核通过：${count} 首开始发进${r.data.channel ? `测试频道 @${r.data.channel}` : '频道'}，发完告诉你`,
    rejected: `❌ 审核失败：${count} 首不发`,
    done: '这张审核单已经审过了',
    missing: '⌛ 这张审核单过期了（搬运服务重启过），要搬的话重新发一次网址',
  }[result] || '';
  await ack(line.slice(0, 190));
  const msg = cb.message;
  if (!msg) return;
  const head = (msg.text || '').split('\n\n逐个核对')[0];  // 去掉最后那句「逐个核对……」
  return tg(env, 'editMessageText', {
    chat_id: msg.chat.id, message_id: msg.message_id, text: `${head}\n\n${line}`.slice(0, 4000), disable_web_page_preview: true,
  });
}

// 审核单的「查看全部」：每一首的歌名、作者、来源链接（编号随机 14 位，知道编号才打得开）
async function harvestReviewPage(env, id, method) {
  if (!streamerOn(env)) return text('Not Found', 404);
  let r;
  try {
    r = await streamerCall(env, `/harvest/review/${id}`);
  } catch {
    return text('搬运服务正在唤醒，过一两分钟再刷新', 503);
  }
  if (r.status === 404) return text('没有这张审核单（可能搬运服务重启过）', 404);
  if (r.status !== 200) return text('搬运服务正在唤醒，过一两分钟再刷新', 503);
  const b = r.data;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const href = u => /^https?:\/\//i.test(u || '') ? esc(u) : '#';
  const state = { review: '待审核', approved: '已通过', rejected: '审核失败，不发' }[b.status] || b.status;
  const rows = (b.tracks || []).map(t => `<li><b>${esc(t.title)}</b>${t.artist ? ' — ' + esc(t.artist) : ''}<br>
<a href="${href(t.page)}" target="_blank" rel="noopener noreferrer">${esc(t.page)}</a></li>`).join('');
  const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>审核单 ${esc(b.id)}</title><style>
body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#fff;color:#222}main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:18px}li{margin:0 0 12px;word-break:break-all}.m{color:#888;font-size:13px}a{color:#e8730c}
@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}
</style></head><body><main><h1>🛂 审核单 ${esc(b.id)}（${esc(b.site)}，${(b.tracks || []).length} 首，确认是不是我们的歌，${esc(state)}）</h1>
<p class="m">${b.query ? `搜：${esc(b.query)}` : `网址：<a href="${href(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.url)}</a>`}<br>
逐个核对，全是我们自己的歌再回机器人点「✅ 审核通过」，整批一起；有不是我们的就点「❌ 审核失败」。</p><ol>${rows}</ol></main></body></html>`;
  return html(page, method, { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' });
}

function rows(buttons, per = 2) {
  const out = [];
  for (let i = 0; i < buttons.length; i += per) out.push(buttons.slice(i, i + per));
  return out;
}

// ── 每天夜里自动搬歌 ───────────────────────────────────────────────
// 先看上一晚那次搬完没有：搬完了就把每个频道「看到哪条了」记下来；再开始今晚这次（只看比上次新的帖子）。
// 流式服务在 Hugging Face 上，久没人用会睡着，先叫醒它
async function nightly(env) {
  if (!streamerOn(env)) return { ok: false, why: 'no streamer' };
  const L = lib(env);
  let up = false;
  for (let i = 0; i < 10 && !up; i++) {
    try {
      const r = await fetch(`${streamerBase(env)}/`, { signal: AbortSignal.timeout(20000) });
      up = r.ok && ((await r.json().catch(() => ({}))).ok === true);
    } catch {}
    if (!up) await new Promise(res => setTimeout(res, 20000));
  }
  if (!up) return { ok: false, why: 'streamer asleep' };
  const alts = await getAlts(env), owner = await ownerId(env);
  if (alts.length && owner) {  // 小号：新歌直接发（和来源频道的自动搬是两件事，互不耽误）
    try { await syncAlts(env, owner, alts); } catch {}
  }
  const auto = await L.getAuto();
  const { data: st } = await streamerCall(env, '/auto/status');
  if (st.status === 'running') return { ok: false, why: 'still running' };
  if (st.run_id && st.run_id === auto.runId && st.sources) {
    for (const [name, info] of Object.entries(st.sources)) {
      if (info && info.max_id) auto.state[name] = Math.max(auto.state[name] || 0, info.max_id);
    }
    auto.lastCopied = st.copied;
  }
  const sources = await L.getSources();
  const runId = new Date().toISOString().slice(0, 19);
  const { status } = await streamerCall(env, '/auto/start', {
    sources: Object.fromEntries(sources.map(s => [s, auto.state[s] || 0])),
    existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    notify: await ownerId(env), run_id: runId, per_source: 30, first_time: 10,
  });
  if (status === 200) { auto.runId = runId; auto.lastStart = new Date().toISOString(); auto.lastCopied = null; }
  await L.setAuto(auto);
  return { ok: status === 200, status, runId };
}

// ── 自动分歌单 ───────────────────────────────────────────────────
// 新歌按歌名里的关键词和歌手放进对应的歌单（一首可以进好几个）；MV、综艺片段、伴奏这类不进歌单，只留在「全部」。
// 都对不上、但有歌手名的，放「华语流行」
const W = s => s.split(' ');
const GENRE_ARTISTS = {
  '经典老歌': W('邓丽君 蔡琴 李宗盛 张学友 刘德华 黎明 郭富城 谭咏麟 张国荣 梅艳芳 王杰 齐秦 童安格 周华健 刘若英 孟庭苇 费玉清 罗大佑 羅大佑 叶倩文 林子祥 许冠杰 陈百强 徐小凤 韩宝仪 卓依婷 甄妮 凤飞飞 高胜美 姜育恒 赵传 伍佰 黄品源 张雨生 郑智化 小虎队 毛阿敏 那英 田震 韦唯 杨钰莹 毛宁 陈慧娴 关淑怡 林忆莲 苏芮 潘美辰 李玲玉 王菲 辛晓琪 黄安 任贤齐 张信哲 刘欢 屠洪刚 郑钧 许巍 汪峰 黑豹 唐朝 Beyond 黄家驹 孙楠 陈淑桦 叶蒨文 周璇 黄莺莺 李翊君 万芳 张宇 光良 品冠 动力火车 庾澄庆 蔡幸娟'),
  '粤语金曲': W('张学友 刘德华 黎明 郭富城 谭咏麟 张国荣 梅艳芳 陈百强 许冠杰 林子祥 叶倩文 Beyond 黄家驹 陈慧娴 关淑怡 李克勤 陈奕迅 杨千嬅 容祖儿 古巨基 郑秀文 卫兰 Twins 谢安琪 吴雨霏 侧田 林峯 张敬轩 周慧敏 许志安 郑中基 薛凯琪 陈小春 草蜢 太极乐队 达明一派 黄耀明 林家谦'),
  '古风国风': W('银临 河图 双笙 等什么君 音阙诗听 小魂 霍尊 司南 叶里 Hita HITA 排骨教主 汐音社 西瓜JUN 灰原穷 刘珂矣 小曲儿 裁缝铺 王朝1982 戴荃 龚琳娜 萨顶顶 徐梦圆 慕寒 李常超 刘烨溦 任安琪 戏班 自得琴社 少司命 国风堂 黄诗扶 乐正绫 洛天依 五音Jw 小坠'),
  '民谣·治愈': W('赵雷 宋冬野 马頔 陈鸿宇 好妹妹 房东的猫 程璧 李志 万能青年旅店 朴树 老狼 郝云 尧十三 陈粒 花粥 谢春花 曾轶可 鹿先森 隔壁老樊 毛不易 刘昊霖 痛仰 新裤子 草东没有派对 告五人 落日飞车 陈绮贞 蛙池 好乐无荒 马良 尹约 宿羽阳 暗杠 福禄寿 门尼 椿乐队 犬儒乐队 银河快递 安与骑兵 莫非定律'),
  '广场舞·民族风': W('凤凰传奇 降央卓玛 乌兰图雅 云飞 杨魏玲花 刀郎 龚玥 阿鲁阿卓 韩红 腾格尔 德德玛 王琪 祁隆 乌兰托娅 李琼 雷佳 宋祖英 卓依婷 庄心妍 云朵 拉毛 斯琴格日乐 布仁巴雅尔 安东阳'),
  '说唱': W('GAI 艾热 法老 马思唯 幼稚园杀手 谢帝 万妮达 VAVA 盛宇 杨和苏 弹壳 小青龙 黄旭 C-BLOCK 功夫胖 布瑞吉 BrAnTB 宝石Gem Capper 蛋堡 热狗 潘玮柏 KEY.L'),
  '华语流行': W('周杰伦 林俊杰 薛之谦 陈奕迅 邓紫棋 G.E.M. 蔡依林 王力宏 孙燕姿 梁静茹 张惠妹 五月天 李荣浩 周深 许嵩 汪苏泷 张杰 华晨宇 田馥甄 S.H.E 萧敬腾 杨丞琳 林宥嘉 徐佳莹 莫文蔚 张韶涵 王心凌 李宇春 张靓颖 周笔畅 郁可唯 任然 单依纯 张碧晨 刘宇宁 胡夏 杨宗纬 方大同 陶喆 蔡健雅 梁博 张远 李健 陈楚生 苏打绿 吴青峰 王嘉尔 易烊千玺 王俊凯 王源 时代少年团 TFBOYS 张艺兴 弦子 王贰浪 苏星婕 程响 海来阿木 承桓 王小帅 小阿七'),
  '伤感情歌': W('海来阿木 承桓 王小帅 小阿七 半吨兄弟 张碧晨 王贰浪 苏星婕 祁隆 王琪 杨宗纬 任然 庄心妍 张宇 刘增瞳 弦子 冷漠 杨坤 曲婉婷 莫叫姐姐 阿冗 周林枫 阿肆'),
};
const GENRE_WORDS = [
  ['DJ 劲爆', /dj|remix|慢摇|串烧|劲爆|电音|蹦迪|disco|嗨曲|舞曲|edm|车载/i],
  ['重低音', /重低音|低音炮|bass|超重低/i],
  ['现场 Live', /live|现场|演唱会/i],
  ['粤语金曲', /粤语|粵語|cantonese/i],
  ['古风国风', /古风|国风|戏腔|古筝|琵琶|二胡/],
  ['广场舞·民族风', /广场舞|民族风|草原|蒙古|藏族|西藏|山歌/],
  ['说唱', /说唱|\brap\b|hiphop|hip-hop|cypher/i],
  ['抖音热歌', /抖音|热播|爆款|网红|tiktok/i],
  ['伤感情歌', /伤感|心碎|心痛|离别|失恋|眼泪|分手|忘不了|放手|错过|遗憾|难过|孤单|寂寞|想你/],
];
const NOT_A_SONG = /\.mp4|\bMV\b|综艺|音乐缘计划|伴奏|铃声|广告|会员|试听|片段|教学|有声书|相声|小品|Lyrics Video|Official Video/i;

function genresOf(t, fallback = true) {
  if (NOT_A_SONG.test(t.title)) return [];
  const text = t.title + ' ' + t.artist, out = new Set();
  for (const [name, re] of GENRE_WORDS) if (re.test(text)) out.add(name);
  for (const [name, list] of Object.entries(GENRE_ARTISTS)) if (t.artist && list.some(a => t.artist.includes(a))) out.add(name);
  // 没写歌手的长串烧、「某某专属定制」之类：DJ 频道打的混音，放 DJ 劲爆
  if (!out.size && !t.artist && ((t.duration || 0) >= 600 || /专属|定制|vol\.?\s*\d|私货|全中文|全英文|全粤语|连版/i.test(t.title))) out.add('DJ 劲爆');
  if (fallback && !out.size && t.artist) out.add('华语流行');
  return [...out];
}

// ── 小工具 ───────────────────────────────────────────────────────

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function stripExt(name) {
  return (name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim();
}

function extFromMime(mime) {
  const ext = Object.keys(MIME_BY_EXT).find(k => MIME_BY_EXT[k] === mime);
  return ext ? '.' + ext : '';
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    ...extra,
  };
}

function text(body, status = 200, extra) {
  return new Response(body, {
    status,
    headers: cors({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra }),
  });
}

// 管理接口的响应不带 CORS 头：别的网站的脚本调不动它
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function html(body, method, extra) {
  return new Response(method === 'HEAD' ? null : body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...extra },
  });
}
