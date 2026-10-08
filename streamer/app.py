"""小橘音乐 · 大文件流式服务（Hugging Face Space）

Telegram 官方 Bot API 只能下载 20 MB 以内的文件，机器人走 MTProto 却没有这个限制。小橘音乐的
Worker 遇到超过 20 MB 的歌，就把浏览器的 Range 请求转到这里（GET /stream/<消息号>）。这里用 Telethon
以机器人身份按消息号取到频道里的原文件，浏览器要哪一段，就从 Telegram 现取哪一段、边取边传：
不落盘，也不用等整首下完。另外 GET /thumb/<消息号> 给出音乐文件自带的专辑封面，Worker 取一次就存起来。

搬歌（频道主要求）：机器人看不到别人的频道，所以另有一个用频道主自己的账号登录的会话（TG_USER_SESSION），
把指定公开频道里的中文歌转到小橘音乐频道（不带「转发自」），转过去的帖子由 Worker 的 webhook 照常登记、查重。
开了「禁止保存内容」的频道 Telegram 不让转，这里也不去绕。登录走 POST /login/code、/login/verify，
搬歌走 /copy/start、/copy/status、/copy/stop。


环境变量（在 Space 的 Settings → Variables and secrets 里设成 secret）：
  TG_API_ID / TG_API_HASH   my.telegram.org 申请的应用凭据
  TG_BOT_TOKEN              机器人 token（和小橘音乐 Worker 里的是同一个）
  TG_CHANNEL                频道用户名，xiaojumusic
  STREAMER_KEY              Worker 转发请求时带的密钥（X-Key 请求头）
  TG_USER_SESSION           （可选）频道主账号的登录凭证，搬歌用；由 /login/verify 生成
和小橘视频合用一个 Space 时（挂在它的 /m 下），两边的机器人、密钥不一样：音乐自己的值存成 MUSIC_ 开头的
名字（MUSIC_TG_BOT_TOKEN、MUSIC_STREAMER_KEY……），有就用它，没有再用不带前缀的。
"""

import asyncio
import base64
import hmac
import io
import logging
import os
import re
import subprocess
import time
import urllib.parse
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from telethon import Button, TelegramClient
from telethon.errors import ChatForwardsRestrictedError, FileReferenceExpiredError, FloodWaitError, SessionPasswordNeededError
from telethon.tl.functions.account import UpdateNotifySettingsRequest
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.contacts import SearchRequest
from telethon.tl.types import DocumentAttributeAudio, InputMessagesFilterMusic, InputMessagesFilterPhotos, InputPeerNotifySettings
from telethon.sessions import StringSession

from harvest.job import Harvester
from harvest.net import Http
from harvest.sites import ADAPTERS as HARVEST_SITES, NetEase

# MTProto 每次最多取 512 KB；起点按它对齐，Telegram 才接受
CHUNK = 512 * 1024

# 消息（连同里面的文件引用）缓存多久。引用在下载途中过期会报错，到时候再重取
MESSAGE_TTL = 30 * 60

# 同一次传输里最多重取几次消息
MAX_REFRESHES = 3

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

log = logging.getLogger('streamer')

def parse_range(header, total):
    """返回 (start, end, partial)；范围没法满足返回 None。认不出的格式、多段 Range 当作要整个文件。"""
    m = re.fullmatch(r'bytes=(\d*)-(\d*)', (header or '').strip())
    if not m or not (m[1] or m[2]):
        return 0, total - 1, False
    if not m[1]:
        n = int(m[2])
        return (max(0, total - n), total - 1, True) if n > 0 else None
    start = int(m[1])
    end = min(int(m[2]), total - 1) if m[2] else total - 1
    if start >= total:
        return None
    if end < start:
        return 0, total - 1, False
    return start, end, True

# ── 音柱数据 ────────────────────────────────────────────────────
# 播放页的音柱要跟着歌真的动。iPhone 上不能把播放器接进 Web Audio 实时分析（锁屏、切后台会没声音），
# 所以在这里把整首歌先算一遍：每秒 VIZ_FPS 帧，每帧 VIZ_BANDS 个频段（50 Hz～5 kHz 按对数分）各多响，
# 每个值 0～15 存成半个字节。网页按播放进度取对应那一帧画出来。
# 格式：b'XV' + 版本 1 + 每秒帧数 + 频段数 + 逐帧、从低频到高频，两个值一个字节（高 4 位在前）
VIZ_RATE = 11025

VIZ_FPS = 15

VIZ_BANDS = 16

VIZ_WIN = 1024

VIZ_MAX_BYTES = 150 * 1024 * 1024   # 再大的（几个小时的串烧）不算

VIZ_MAX_SECONDS = 3 * 3600

def decode_pcm(data):
    """任意音频 → 单声道 11025 Hz 的 int16 采样（用 ffmpeg）。解不了返回 None。"""
    try:
        r = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-t', str(VIZ_MAX_SECONDS), '-ac', '1', '-ar', str(VIZ_RATE),
                            '-f', 's16le', 'pipe:1'], input=data, capture_output=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        log.exception('ffmpeg failed')
        return None
    if not r.stdout:
        return None
    return np.frombuffer(r.stdout[:len(r.stdout) // 2 * 2], dtype='<i2')

def viz_levels(pcm, rate=VIZ_RATE, fps=VIZ_FPS, bands=VIZ_BANDS):
    """采样 → 每帧每个频段 0～15 的二维数组（帧数 × 频段）。每个频段按这首歌里它自己最响的时候定满格，
    低于那个 30 dB 算 0：高频本来就弱，不分开算的话右边的柱子永远是平的。"""
    x = pcm.astype(np.float32) / 32768
    hop = rate // fps
    frames = max(1, len(x) // hop)
    x = np.concatenate([x, np.zeros(VIZ_WIN, np.float32)])
    win = np.hanning(VIZ_WIN).astype(np.float32)
    freqs = np.fft.rfftfreq(VIZ_WIN, 1 / rate)
    edges = np.geomspace(50, 5000, bands + 1)
    masks = []
    for b in range(bands):
        m = (freqs >= edges[b]) & (freqs < edges[b + 1])
        if not m.any():  # 最低几个频段可能比一个频点还窄：取最近的那个频点
            m = np.zeros_like(m)
            m[np.argmin(np.abs(freqs - (edges[b] + edges[b + 1]) / 2))] = True
        masks.append(m)
    db = np.empty((frames, bands), np.float32)
    for f0 in range(0, frames, 2000):  # 分批算，几十分钟的串烧也不会一下吃掉太多内存
        f1 = min(frames, f0 + 2000)
        idx = np.arange(VIZ_WIN)[None, :] + hop * np.arange(f0, f1)[:, None]
        power = np.abs(np.fft.rfft(x[idx] * win, axis=1)) ** 2
        for b, m in enumerate(masks):
            db[f0:f1, b] = 10 * np.log10(power[:, m].mean(axis=1) + 1e-10)
    top = np.percentile(db, 98, axis=0)
    loud = np.percentile(db, 98)
    top = np.maximum(top, loud - 24)  # 某个频段整首都几乎没声音，就别把它的噪音放大成满格
    v = np.clip((db - (top - 30)) / 30, 0, 1) ** 1.3
    return np.rint(v * 15).astype(np.uint8)

def pack_viz(levels, fps=VIZ_FPS):
    flat = levels.reshape(-1)
    if len(flat) % 2:
        flat = np.concatenate([flat, np.zeros(1, np.uint8)])
    packed = (flat[0::2] << 4) | flat[1::2]
    return b'XV' + bytes([1, fps, levels.shape[1]]) + packed.astype(np.uint8).tobytes()

viz_gate = asyncio.Semaphore(2)  # 同时最多算两首，免得把免费的 CPU 占满、拖慢播放

class Streamer:
    """下载和取消息的实现由外面注入，方便测试。"""

    def __init__(self, *, channel, fetch_message, iter_download, download_thumb=None, download_photo=None,
                 clock=time.monotonic):
        self.channel = channel
        self.fetch_message = fetch_message    # async (频道, 消息号) -> Telethon 消息或 None
        self.iter_download = iter_download    # (文件, offset=, request_size=, file_size=) -> 异步迭代的字节块
        self.download_thumb = download_thumb  # async (消息) -> 封面缩略图的 JPEG 字节或 None
        self.download_photo = download_photo  # async (消息) -> 图片帖里合适尺寸的 JPEG 字节
        self.scan = None                      # (upto, 图片帖消息号列表, 扫描时间)
        self.clock = clock
        self.cache = {}  # 消息号 -> (消息, 取到的时间)

    async def message(self, message_id, fresh=False):
        hit = self.cache.get(message_id)
        if hit and not fresh and self.clock() - hit[1] < MESSAGE_TTL:
            return hit[0]
        msg = await self.fetch_message(self.channel, message_id)
        if msg is None or getattr(msg, 'document', None) is None:
            self.cache.pop(message_id, None)
            return None
        if len(self.cache) > 200:
            self.cache.clear()
        self.cache[message_id] = (msg, self.clock())
        return msg

    async def thumbnail(self, message_id):
        """音乐文件自带的专辑封面（Telegram 生成的缩略图，最大那张，通常 320×320）；没有就返回 None。"""
        msg = await self.message(message_id)
        if msg is None or not getattr(msg.document, 'thumbs', None):
            return None
        return await self.download_thumb(msg)

    async def photo_ids(self, upto):
        """频道里 1..upto 号消息中哪些是图片帖。机器人不能翻历史，只能按消息号每 100 条批量取。结果缓存 10 分钟。"""
        if self.scan and self.scan[0] >= upto and self.clock() - self.scan[2] < 600:
            return self.scan[1]
        ids = []
        for first in range(1, upto + 1, 100):
            msgs = await self.fetch_message(self.channel, list(range(first, min(first + 100, upto + 1))))
            ids += [m.id for m in msgs if m is not None and getattr(m, 'photo', None)]
        self.scan = (upto, ids, self.clock())
        return ids

    async def photo(self, message_id):
        msg = await self.fetch_message(self.channel, message_id)
        if msg is None or not getattr(msg, 'photo', None):
            return None
        return await self.download_photo(msg)

    async def body(self, message_id, start, end):
        """边取边吐 [start, end] 这段字节。文件引用在途中过期就重取消息，从断开的地方接着传。"""
        pos = start
        refreshes = 0
        while pos <= end:
            msg = await self.message(message_id, fresh=refreshes > 0)
            if msg is None:
                raise RuntimeError(f'message {message_id} disappeared mid-stream')
            doc = msg.document
            aligned = pos - pos % CHUNK
            skip = pos - aligned
            stream = self.iter_download(doc, offset=aligned, request_size=CHUNK, file_size=doc.size)
            try:
                async for chunk in stream:
                    if skip:
                        if len(chunk) <= skip:
                            skip -= len(chunk)
                            continue
                        chunk, skip = chunk[skip:], 0
                    chunk = chunk[:end - pos + 1]
                    yield chunk
                    pos += len(chunk)
                    if pos > end:
                        return
                return  # 文件比预期短：到此为止，响应长度对不上，Worker 会发现
            except FileReferenceExpiredError:
                refreshes += 1
                if refreshes > MAX_REFRESHES:
                    raise
                log.info('message %s: file reference expired at byte %s, refetching', message_id, pos)
            finally:
                # 提前退出（传够了、出错、浏览器断开）时要主动关掉，Telethon 才会归还连到别的数据中心的连接
                close = getattr(stream, 'aclose', None) or getattr(stream, 'close', None)
                if close:
                    try:
                        await close()
                    except Exception:  # noqa: BLE001 — Telethon 没取过数据就关会报 AttributeError，不能盖住真正的错误
                        log.debug('closing download iterator failed', exc_info=True)

# ── 搬歌 ──────────────────────────────────────────────────────────

CJK = re.compile(r'[一-鿿]')

# 日文假名、韩文：有这些的是日韩歌（只用汉字写的日本歌手名分不出来）
KANA_HANGUL = re.compile(r'[぀-ヿ가-힯]')

def is_chinese(text):
    return bool(CJK.search(text)) and not KANA_HANGUL.search(text)

def norm(s):
    return re.sub(r'[\W_]+', '', (s or '').lower())

def clean_names(title, performer):
    """和 Worker 的 summary() 一样理歌名、歌手：去掉「@频道」「更多音乐」，没有歌手时拆「歌手 - 歌名」。"""
    title = (title or '').strip()
    artist = re.sub(r'\s+', ' ', re.sub(r'@\w+|更多音乐', '', performer or '')).strip()
    if not artist:
        m = re.match(r'^(.+?)\s+-\s+(.+)$', title)
        if m:
            artist, title = m[1].strip(), m[2].strip()
    return title, artist

def song_key(title, performer):
    t, a = clean_names(title, performer)
    return norm(t) + '|' + norm(a)

class Copier:
    """把 source 频道里的中文歌（歌名或歌手里有汉字）从新到旧转到 target，跳过已有的，最多 limit 首。

    iter_music(source, min_id=) 异步给出 (消息, 歌名, 歌手, 秒数)，只给消息号大于 min_id 的；
    forward(target, 消息) 转一条；say(chat_id, 文字) 用机器人发消息通知（可以不给）。都由外面注入，方便测试。"""

    def __init__(self, *, iter_music, forward, say=None, sleep=asyncio.sleep, pause=3.0):
        self.iter_music = iter_music
        self.forward = forward
        self.say = say
        self.sleep = sleep
        self.pause = pause
        self.task = None
        self.state = {'status': 'idle'}

    def running(self):
        return self.task is not None and not self.task.done()

    def _fresh_state(self, **extra):
        return {'status': 'running', 'scanned': 0, 'copied': 0, 'skipped_lang': 0, 'skipped_dup': 0,
                'skipped_other': 0, 'recent': [], 'new_ids': [], 'error': '', **extra}

    def start(self, source, target, limit, existing, dry_run=False, keywords=(), min_seconds=0, chinese_only=True,
              notify=None, max_seconds=0):
        """keywords：给了就只要歌名或歌手里含其中一个词的（不分大小写）；min_seconds：比这短的是片段，不要；
        max_seconds：比这长的（一两个小时的串烧）不要，0 表示不限；chinese_only：只要中文歌；
        notify：搬完用机器人给这个聊天发一条结果。"""
        if self.running():
            raise RuntimeError('already running')
        self.state = self._fresh_state(source=source, limit=limit, dry_run=dry_run)
        seen = {song_key(t, a) for t, a in existing}
        rule = (tuple(k.lower() for k in keywords if k), min_seconds, chinese_only, max_seconds)
        self.task = asyncio.create_task(self._single(source, target, limit, seen, dry_run, rule, notify))

    def start_auto(self, sources, target, existing, *, per_source=50, first_time=20, min_seconds=60, max_seconds=1200,
                   notify=None, run_id=''):
        """每天夜里的自动搬：sources 是 {频道: 上次看到的最大消息号}，只看比它新的帖子；
        第一次（0）只看最新的 first_time 首。结果里 sources 给出每个频道这次看到的最大消息号，下次接着用。"""
        if self.running():
            raise RuntimeError('already running')
        self.state = self._fresh_state(mode='auto', run_id=run_id, sources={})
        seen = {song_key(t, a) for t, a in existing}
        rule = ((), min_seconds, True, max_seconds)
        self.task = asyncio.create_task(self._auto(dict(sources), target, seen, rule, per_source, first_time, notify))

    def stop(self):
        if self.running():
            self.task.cancel()

    async def _single(self, source, target, limit, seen, dry_run, rule, notify):
        st = self.state
        try:
            await self.copy_source(source, target, limit, seen, dry_run, rule, 0)
            st['status'] = 'done'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except ChatForwardsRestrictedError:
            st['status'], st['error'] = 'error', 'protected'
        except Exception as e:  # noqa: BLE001 — 记下来给 /copy/status 看
            log.exception('copy failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'
        if notify:
            if st['status'] == 'done':
                msg = f'✅ 从 @{source} 搬了 {st["copied"]} 首（重复跳过 {st["skipped_dup"]}，外语跳过 {st["skipped_lang"]}）'
                if st['recent']:
                    msg += '\n' + '\n'.join('· ' + r for r in st['recent'][:10])
            elif st['error'] == 'protected':
                msg = f'⛔ @{source} 禁止转发，搬不了'
            else:
                msg = f'⚠️ 从 @{source} 搬歌出错了：{st["error"] or st["status"]}（已搬 {st["copied"]} 首）'
            await self.tell(notify, msg)

    async def _auto(self, sources, target, seen, rule, per_source, first_time, notify):
        st = self.state
        for source, min_id in sources.items():
            info = {'max_id': min_id or 0, 'copied': 0, 'error': ''}
            st['sources'][source] = info
            before = st['copied']
            try:
                limit = per_source if min_id else first_time
                info['max_id'] = await self.copy_source(source, target, limit, seen, False, rule, min_id or 0,
                                                       scan_cap=None if min_id else first_time * 3) or info['max_id']
            except asyncio.CancelledError:
                st['status'] = 'stopped'
                return
            except ChatForwardsRestrictedError:
                info['error'] = 'protected'
            except Exception as e:  # noqa: BLE001 — 一个频道出错不影响后面的
                log.exception('auto copy %s failed', source)
                info['error'] = f'{type(e).__name__}: {e}'[:200]
            info['copied'] = st['copied'] - before
        st['status'] = 'done'
        if notify:
            got = [(s, i['copied']) for s, i in st['sources'].items() if i['copied']]
            msg = f'🌙 夜里自动搬歌：新增 {st["copied"]} 首'
            if got:
                msg += '\n' + '\n'.join(f'· @{s}：{n} 首' for s, n in got)
            if st['recent']:
                msg += '\n\n最新几首：\n' + '\n'.join('· ' + r for r in st['recent'][:8])
            bad = [s for s, i in st['sources'].items() if i['error'] and i['error'] != 'protected']
            if bad:
                msg += f'\n\n这几个频道没看成：{", ".join("@" + b for b in bad[:10])}'
            await self.tell(notify, msg)

    async def tell(self, chat_id, text):
        if not self.say:
            return
        try:
            await self.say(chat_id, text)
        except Exception:  # noqa: BLE001 — 通知发不出去不影响搬歌
            log.exception('notify failed')

    async def copy_source(self, source, target, limit, seen, dry_run, rule, min_id, scan_cap=None):
        """搬一个频道，返回看到的最大消息号。禁止转发的频道抛 ChatForwardsRestrictedError。"""
        keywords, min_seconds, chinese_only, max_seconds = rule
        st = self.state
        top, scanned, copied = min_id, 0, 0  # copied：这个频道这次搬了几首（自动搬时 st['copied'] 是几个频道的合计）
        async for msg, title, performer, seconds in self.iter_music(source, min_id=min_id):
            top = max(top, getattr(msg, 'id', 0) or 0)
            if copied >= limit or (scan_cap and scanned >= scan_cap):
                break
            scanned += 1
            st['scanned'] += 1
            text = (title or '') + ' ' + (performer or '')
            if chinese_only and not is_chinese(text):
                st['skipped_lang'] += 1
                continue
            if (keywords and not any(k in text.lower() for k in keywords)) or (seconds or 0) < min_seconds \
                    or (max_seconds and (seconds or 0) > max_seconds):
                st['skipped_other'] += 1
                continue
            key = song_key(title, performer)
            if key in seen:
                st['skipped_dup'] += 1
                continue
            if not dry_run:
                sent = await self.forward_patiently(target, msg)
                new_id = getattr(sent[0] if isinstance(sent, list) and sent else sent, 'id', None)
                if new_id:
                    st['new_ids'].append(new_id)
                await self.sleep(self.pause)  # 慢慢来，免得账号被限制
            seen.add(key)
            st['copied'] += 1
            copied += 1
            t, a = clean_names(title, performer)
            st['recent'] = ([f'{a} - {t}' if a else t] + st['recent'])[:30]
        return top

    async def forward_patiently(self, target, msg):
        for attempt in range(3):
            try:
                return await self.forward(target, msg)
            except FloodWaitError as e:  # Telegram 叫我们等一会儿
                if attempt == 2 or e.seconds > 3600:
                    raise
                self.state['waiting'] = e.seconds
                await self.sleep(e.seconds + 1)
                self.state.pop('waiting', None)

class Login:
    """账号登录两步走：先发验证码，再用验证码（开了两步验证时再加密码）登录。"""

    def __init__(self, make_user_client):
        self.make_user_client = make_user_client
        self.pending = None  # (客户端, 手机号, phone_code_hash)
        self.need_password = False

    async def send_code(self, phone):
        client = self.make_user_client(StringSession())
        await client.connect()
        sent = await client.send_code_request(phone)
        self.pending, self.need_password = (client, phone, sent.phone_code_hash), False

    async def verify(self, code, password=None):
        """成功返回已登录的客户端；要两步验证密码而没给时抛 SessionPasswordNeededError（可以带密码再调一次）。"""
        if not self.pending:
            raise RuntimeError('no code requested')
        client, phone, code_hash = self.pending
        if not self.need_password:
            try:
                await client.sign_in(phone=phone, code=code, phone_code_hash=code_hash)
            except SessionPasswordNeededError:
                self.need_password = True  # 验证码已经对了，下次只交密码
        if self.need_password:
            if not password:
                raise SessionPasswordNeededError(request=None)
            await client.sign_in(password=password)
        self.pending, self.need_password = None, False
        return client

def settings():
    """环境变量；MUSIC_ 开头的盖过同名不带前缀的（和小橘视频合用 Space 时，音乐的机器人、密钥存在这些名字下）"""
    env = dict(os.environ)
    env.update({k[len('MUSIC_'):]: v for k, v in os.environ.items() if k.startswith('MUSIC_') and v})
    return env

def make_client(env):
    # receive_updates=False：这个 MTProto 会话只调用、不订阅推送。机器人同时挂在官方 Bot API 上收
    # webhook，Telegram 给同一个机器人的推送可能只送到其中一个会话；这里要是订阅了，频道新帖的推送
    # 就可能被它接走，Worker 就漏登记新歌（自建 telegram-bot-api 要先 logOut 官方服务器也是这个原因）
    return TelegramClient(StringSession(), int(env['TG_API_ID']), env['TG_API_HASH'], receive_updates=False)

streamer = None

harvester = None    # 贴网址搬自己的歌（抓取 → 审核单 → 通过后发）

bot_client = None   # 机器人账号（取文件、发通知）

user_client = None  # 频道主账号（搬歌用），没登录时为 None

copier = None

login = None

netease_proc = None  # 本机的 api-enhanced（网易云接口）进程

# api-enhanced（NeteaseCloudMusicApiEnhanced，npm 包 @neteasecloudmusicapienhanced/api）：镜像构建时装好
NETEASE_API_JS = '/opt/netease-api/node_modules/@neteasecloudmusicapienhanced/api/app.js'

async def start_netease_api(env):
    """在本机拉起 api-enhanced，只听 127.0.0.1（外面访问不到）。没装就只记日志：贴网址、爬歌用不了，播放不受影响"""
    global netease_proc
    js = env.get('NETEASE_API_JS', NETEASE_API_JS)
    if not os.path.exists(js):
        log.warning('api-enhanced not installed at %s; NetEase harvesting is off', js)
        return
    port = urllib.parse.urlparse(NetEase().api).port or 3017
    # 它会把请求（含登录 cookie）打进日志，所以丢掉它的输出，只留报错
    netease_proc = await asyncio.create_subprocess_exec(
        'node', js, env={**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1'},
        stdout=asyncio.subprocess.DEVNULL, stderr=None)
    log.info('api-enhanced starting on 127.0.0.1:%s', port)

def user_music(client):
    async def iter_music(source, min_id=0):
        async for msg in client.iter_messages(source, filter=InputMessagesFilterMusic, min_id=min_id or 0):
            f = msg.file
            if f is None:
                continue
            yield (msg, f.title or re.sub(r'\.[a-z0-9]{1,5}$', '', f.name or '', flags=re.I), f.performer or '',
                   f.duration or 0)
    return iter_music

def set_user_client(client):
    global user_client, copier
    user_client = client

    async def forward(target, msg):
        # drop_author：转过去是一条新帖，不带「转发自」
        return await client.forward_messages(target, msg, drop_author=True)

    copier = Copier(iter_music=user_music(client), forward=forward, say=bot_say)

async def bot_say(chat_id, text, buttons=None):
    """用机器人给某个聊天发消息（通知频道主、回复求歌的人）。对方得先和机器人说过话才收得到。
    buttons：[[(文字, 按钮数据), ...], ...]，按了由 Worker 的 webhook 收（这个会话不收推送）"""
    if bot_client is None:
        return
    rows = [[Button.inline(t, d.encode()) for t, d in row] for row in buttons] if buttons else None
    await bot_client.send_message(int(chat_id), text, link_preview=False, buttons=rows)

@asynccontextmanager
async def lifespan(app):
    global streamer
    env = settings()
    client = make_client(env)
    await client.start(bot_token=env['TG_BOT_TOKEN'])
    global bot_client, harvester
    bot_client = client

    async def post_audio(data, filename, title, artist, seconds, text, channel=''):
        # 用频道主账号发帖：机器人收不到自己发的帖子，用它发的话 Worker 不会登记。
        # 带上歌名、作者、时长，Telegram 才当成音乐；大文件也能发
        if user_client is None:
            raise RuntimeError('channel owner account not logged in')
        f = io.BytesIO(data)
        f.name = filename
        sent = await user_client.send_file(channel or target_channel(), f, caption=text, link_preview=False,
                                      attributes=[DocumentAttributeAudio(duration=seconds, title=title[:64], performer=artist[:64])])
        return sent.id

    harvester = Harvester(http=Http(), send=post_audio, say=bot_say)
    log.info('logged in to Telegram as a bot')
    try:
        await start_netease_api(env)
    except Exception:  # noqa: BLE001
        log.exception('api-enhanced failed to start')

    async def fetch_message(channel, message_id):
        return await client.get_messages(channel, ids=message_id)

    async def download_thumb(msg):
        # 传消息本身（不是 msg.document）：Telethon 才能在文件引用过期时自己重取消息
        return await client.download_media(msg, file=bytes, thumb=-1)

    async def download_photo(msg):
        # 取边长不超过 800 的最大一档（当封面够清楚，又不至于太大）；都超过就取最小的
        sizes = [s for s in msg.photo.sizes if getattr(s, 'w', 0) and getattr(s, 'h', 0)]
        fit = [s for s in sizes if max(s.w, s.h) <= 800]
        size = max(fit, key=lambda s: s.w * s.h) if fit else min(sizes, key=lambda s: s.w * s.h)
        return await client.download_media(msg, file=bytes, thumb=size)

    streamer = Streamer(channel=env.get('TG_CHANNEL', 'xiaojumusic'), fetch_message=fetch_message,
                        iter_download=client.iter_download, download_thumb=download_thumb, download_photo=download_photo)

    global login
    login = Login(lambda session: TelegramClient(session, int(env['TG_API_ID']), env['TG_API_HASH'], receive_updates=False))
    if env.get('TG_USER_SESSION'):
        try:
            u = login.make_user_client(StringSession(env['TG_USER_SESSION']))
            await u.connect()
            if await u.is_user_authorized():
                set_user_client(u)
                # 把聊天列表里的频道先记进缓存：用名字找已加入的频道时就不用再「查用户名」，
                # 查用户名的次数 Telegram 卡得很严，多查几次就要等好几个小时
                await u.get_dialogs()
                log.info('user session ready')
            else:
                log.warning('TG_USER_SESSION is no longer valid')
        except Exception:  # noqa: BLE001 — 搬歌用不了不影响播放
            log.exception('user session failed')
    try:
        yield
    finally:
        if netease_proc and netease_proc.returncode is None:
            netease_proc.terminate()
        if copier:
            copier.stop()
        if user_client:
            await user_client.disconnect()
        await client.disconnect()

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

@app.get('/')
async def health():
    return {'ok': True}

def check_key(request):
    got = request.headers.get('x-key', '').encode()
    want = settings().get('STREAMER_KEY', '').encode()
    if not want or not hmac.compare_digest(got, want):
        raise HTTPException(403)

@app.get('/thumb/{message_id}')
async def thumb(message_id: int, request: Request):
    check_key(request)
    data = await streamer.thumbnail(message_id)
    if not data:
        raise HTTPException(404)
    return Response(content=data, media_type='image/jpeg')

@app.get('/photos')
async def photos(upto: int, request: Request):
    check_key(request)
    return {'photos': await streamer.photo_ids(max(1, min(upto, 100000)))}

@app.get('/photo/{message_id}')
async def photo(message_id: int, request: Request):
    check_key(request)
    data = await streamer.photo(message_id)
    if not data:
        raise HTTPException(404)
    return Response(content=data, media_type='image/jpeg')

@app.get('/stream/{message_id}')
async def stream(message_id: int, request: Request):
    check_key(request)
    msg = await streamer.message(message_id)
    if msg is None:
        raise HTTPException(404)
    return ranged(streamer, msg, message_id, request)

def ranged(s, msg, message_id, request):
    """按浏览器的 Range 边取边传这条消息里的文件（Worker 转过来的请求）"""
    size = msg.document.size
    rng = parse_range(request.headers.get('range'), size)
    if rng is None:
        return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
    start, end, partial = rng
    headers = {'Accept-Ranges': 'bytes', 'Content-Length': str(end - start + 1)}
    if partial:
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    return StreamingResponse(s.body(message_id, start, end), status_code=206 if partial else 200,
                             headers=headers, media_type='application/octet-stream')

@app.get('/viz/{message_id}')
async def viz(message_id: int, request: Request):
    """这首歌的音柱数据（格式见 pack_viz）。不是音频、太大或解不出来：404（Worker 记下来不再问）。"""
    check_key(request)
    msg = await streamer.message(message_id)
    if msg is None or not (getattr(msg.document, 'mime_type', '') or '').startswith(('audio/', 'video/')) or msg.document.size > VIZ_MAX_BYTES:
        raise HTTPException(404)
    async with viz_gate:
        data = bytearray()
        async for chunk in streamer.body(message_id, 0, msg.document.size - 1):
            data.extend(chunk)
        pcm = await asyncio.to_thread(decode_pcm, bytes(data))
        if pcm is None or len(pcm) < VIZ_RATE:
            raise HTTPException(404)
        levels = await asyncio.to_thread(viz_levels, pcm)
    return Response(content=pack_viz(levels), media_type='application/octet-stream')

# ── 登录、搬歌（都要 X-Key）─────────────────────────────────────────

def target_channel():
    return settings().get('TG_CHANNEL', 'xiaojumusic')

@app.post('/login/code')
async def login_code(request: Request):
    check_key(request)
    phone = str((await request.json()).get('phone', '')).strip()
    if not re.fullmatch(r'\+?\d{6,16}', phone):
        raise HTTPException(400, 'bad phone')
    await login.send_code(phone)
    return {'ok': True}

@app.post('/login/verify')
async def login_verify(request: Request):
    check_key(request)
    body = await request.json()
    try:
        client = await login.verify(str(body.get('code', '')).strip(), body.get('password') or None)
    except SessionPasswordNeededError:
        return {'ok': False, 'need_password': True}
    set_user_client(client)
    me = await client.get_me()
    try:
        perm = await client.get_permissions(target_channel(), 'me')
        can_post = bool(perm.is_creator or (perm.is_admin and perm.post_messages))
    except Exception:  # noqa: BLE001 — 不在频道里
        can_post = False
    # 登录凭证只在这里给一次，要存成 Space 的 secret（TG_USER_SESSION），重启后才还能用
    return {'ok': True, 'session': client.session.save(), 'can_post': can_post,
            'me': {'id': me.id, 'name': ' '.join(x for x in [me.first_name, me.last_name] if x), 'username': me.username}}

@app.post('/copy/start')
async def copy_start(request: Request):
    check_key(request)
    if copier is None:
        raise HTTPException(409, 'not logged in')
    body = await request.json()
    source = str(body.get('source', '')).strip().lstrip('@')
    if not re.fullmatch(r'\w{4,64}', source):
        raise HTTPException(400, 'bad source')
    existing = [(str(t), str(a)) for t, a in body.get('existing', [])]
    limit = max(1, min(int(body.get('limit', 50)), 2000))
    try:
        keywords = [str(k)[:30] for k in body.get('keywords', [])][:30]
        copier.start(source, target_channel(), limit, existing, bool(body.get('dry_run')), keywords,
                     max(0, int(body.get('min_seconds', 0))), bool(body.get('chinese_only', True)),
                     notify=body.get('notify') or None, max_seconds=max(0, int(body.get('max_seconds', 0))))
    except RuntimeError:
        raise HTTPException(409, 'already running')
    return copier.state

@app.post('/auto/start')
async def auto_start(request: Request):
    """每天夜里的自动搬（Worker 的定时任务来调）：{sources: {频道: 上次的最大消息号}, existing, notify, run_id}。
    正在搬别的就 409，明天再说。"""
    check_key(request)
    if copier is None:
        raise HTTPException(409, 'not logged in')
    body = await request.json()
    sources = {str(k).strip().lstrip('@'): int(v or 0) for k, v in (body.get('sources') or {}).items()
               if re.fullmatch(r'@?\w{4,64}', str(k).strip())}
    existing = [(str(t), str(a)) for t, a in body.get('existing', [])]
    try:
        copier.start_auto(sources, target_channel(), existing, per_source=max(1, min(int(body.get('per_source', 50)), 500)),
                          first_time=max(1, min(int(body.get('first_time', 20)), 200)), notify=body.get('notify') or None,
                          run_id=str(body.get('run_id', ''))[:40])
    except RuntimeError:
        raise HTTPException(409, 'already running')
    return {'ok': True}

@app.get('/auto/status')
async def auto_status(request: Request):
    check_key(request)
    if copier is None:
        return {'status': 'idle'}
    st = copier.state
    return {k: st.get(k) for k in ('status', 'mode', 'run_id', 'sources', 'copied', 'error')}

# ── 贴网址搬自己的歌：抓出网址里的歌 → 审核单 → 频道主确认是我们的歌点通过 → 发进频道（逻辑在 harvest/ 里）──

@app.get('/harvest/options')
async def harvest_options(request: Request):
    """搬运设置里能选的网站。"""
    check_key(request)
    return {'sites': [{'key': a.key, 'name': a.name} for a in HARVEST_SITES]}

@app.post('/harvest')
async def harvest_start(request: Request):
    """{url 或 query, settings: {sites, limit}, existing, notify, link}：开始抓（query 是按关键词去网站上搜），抓完发审核单。
    网址不支持或网站关着 → 400 带原因；正在忙 → 409。"""
    check_key(request)
    if harvester is None:
        raise HTTPException(409, 'not ready')
    body = await request.json()
    url = str(body.get('url') or '').strip()
    query = str(body.get('query') or '').strip()[:60]
    if not query and not re.match(r'^https?://', url):
        raise HTTPException(400, '不是网址')
    existing = [(str(t), str(a)) for t, a in body.get('existing', [])]
    try:
        harvester.start(url, body.get('settings') or {}, existing, notify=body.get('notify') or None,
                        link=str(body.get('link') or ''), query=query)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError:
        raise HTTPException(409, {'busy': harvester.busy_text()})
    return {'ok': True, 'site': harvester.state.get('site')}

@app.post('/harvest/count')
async def harvest_count(request: Request):
    """{url, settings, existing} → {site, kind, name, total, have}：抓之前先数一数（不出审核单）。网址不支持 → 400"""
    check_key(request)
    if harvester is None:
        raise HTTPException(409, 'not ready')
    body = await request.json()
    url = str(body.get('url') or '').strip()
    if not re.match(r'^https?://', url):
        raise HTTPException(400, '不是网址')
    existing = [(str(t), str(a)) for t, a in body.get('existing', [])]
    try:
        # 自己的 Http，请求间隔短一些：Worker 等不了太久（几百首要翻十几页）
        return await harvester.count(url, body.get('settings') or {}, existing, http=Http(gap=0.2))
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.get('/harvest/status')
async def harvest_status(request: Request):
    check_key(request)
    return harvester.state if harvester else {'status': 'idle'}

@app.get('/harvest/review/{sid}')
async def harvest_sheet(sid: str, request: Request):
    """审核单的每一首（Worker 的「查看全部」网页用）。没有这张（服务重启过）→ 404"""
    check_key(request)
    info = harvester.sheet_info(sid) if harvester else None
    if info is None:
        raise HTTPException(404, 'no such sheet')
    return info

@app.post('/harvest/review')
async def harvest_decide(request: Request):
    """频道主按了审核单的按钮：{id, ok, existing, notify, channel} → {result, count, channel}。channel：发到这个测试频道（空＝正式频道）。
    result：approved 开始发 / rejected 不发 / done 已经审过 / busy 正在搬别的 / missing 没有这张（服务重启过）"""
    check_key(request)
    if harvester is None:
        raise HTTPException(409, 'not ready')
    body = await request.json()
    existing = [(str(t), str(a)) for t, a in body.get('existing', [])]
    channel = str(body.get('channel') or '').lstrip('@')
    if channel and not re.match(r'^\w{4,64}$', channel):
        raise HTTPException(400, 'bad channel')
    result, count = harvester.decide(str(body.get('id', '')), bool(body.get('ok')), existing,
                                     notify=body.get('notify') or None, channel=channel, cookie=str(body.get('cookie') or ''))
    return {'result': result, 'count': count, 'channel': channel, 'busy': harvester.busy_text() if result == 'busy' else ''}

# ── 网易云登录：频道主扫码，登录凭证（cookie）先留在这里，Worker 下次来（GET /netease/session）取走存着，
# 每次审核通过时带过来取 VIP 歌的下载地址。不主动推给 Worker：Hugging Face 的机房挡掉了 *.workers.dev ──

netease_login_task = None

netease_session = {}  # 刚扫码登录的 {cookie, nickname, at}，等 Worker 来取

async def netease_login(notify, key=None, poll=3.0, wait=180):
    """二维码发给频道主 → 等他扫码确认 → cookie 记在 netease_session"""
    global netease_session
    ne, http = NetEase(), Http(gap=0)
    try:
        key = key or (await ne._get(http, '/login/qr/key', timestamp=str(time.time_ns())))['data']['unikey']
        img = (await ne._get(http, '/login/qr/create', key=key, qrimg='true'))['data']['qrimg']
        f = io.BytesIO(base64.b64decode(img.split(',', 1)[1]))
        f.name = 'netease-login.png'
        await bot_client.send_file(int(notify), f, caption='用网易云 App 扫码登录小橘音乐的网易云账号（3 分钟内有效）')
        for _ in range(int(wait / poll)):
            await asyncio.sleep(poll)
            r = await http.get_json(ne.api + '/login/qr/check', {'key': key, 'noCookie': 'true', 'timestamp': str(time.time_ns())})
            if r.get('code') == 800:
                break
            if r.get('code') == 803 and r.get('cookie'):
                cookie = r['cookie']
                acc = await http.get_json(ne.api + '/user/account', {'cookie': cookie, 'timestamp': str(time.time_ns())})
                nick = ((acc.get('profile') or {}).get('nickname')) or ''
                netease_session = {'cookie': cookie, 'nickname': nick, 'at': int(time.time() * 1000)}
                return await bot_say(notify, f'✅ 网易云已登录：{nick or "（没取到昵称）"}。以后审核通过的 VIP 歌用这个账号下载')
        await bot_say(notify, '⌛ 二维码过期了，要登录的话再发一次「网易云登录」')
    except Exception as e:  # noqa: BLE001
        log.exception('netease login failed')
        await bot_say(notify, f'⚠️ 网易云登录出错了：{type(e).__name__}')

@app.post('/netease/login')
async def netease_login_start(request: Request):
    """{notify}：给频道主发网易云登录二维码。正在等扫码时再发一次就换一张新的"""
    check_key(request)
    global netease_login_task
    if bot_client is None or netease_proc is None:
        raise HTTPException(409, 'not ready')
    body = await request.json()
    if netease_login_task and not netease_login_task.done():
        netease_login_task.cancel()
    netease_login_task = asyncio.create_task(netease_login(body.get('notify')))
    return {'ok': True}

@app.get('/netease/session')
async def netease_session_get(request: Request):
    """Worker 来取刚扫码登录的 {cookie, nickname, at}（没有就是 {}）。取走后这里还留着，Worker 按 at 只存更新的"""
    check_key(request)
    return netease_session

# ── 求歌：听众私聊机器人一个歌名，库里没有时到来源频道里找一首最像的搬进来 ──

FLAVOR = re.compile(r'dj|remix|伴奏|片段|live|现场|翻自|cover|翻唱|加速|降调|铃声|0\.\dx', re.I)

def rank_requests(q, results):
    """给搜到的音频按「像不像用户要的那首」打分排序，只留够像的（分数 ≥ 50）。
    歌名一样最好；歌名里含要找的词次之；用户写了「歌名 歌手」时歌名、歌手都对上也算一样。
    DJ 版、伴奏、片段之类，用户没提就往后排；太短（片段）、太长（串烧）的不要。"""
    nq = norm(q)
    want_flavor = bool(FLAVOR.search(q))
    # 同一个歌名，哪个歌手出现得多（好几个频道都传了）多半就是原唱；只出现一次的多是翻唱
    fame = {}
    for r in results:
        t, a = clean_names(r.get('title', ''), r.get('performer', ''))
        k = (norm(t), norm(a))
        fame[k] = fame.get(k, 0) + 1
    out = []
    for r in results:
        t, a = clean_names(r.get('title', ''), r.get('performer', ''))
        nt, na = norm(t), norm(a)
        if not nt or not (60 <= (r.get('duration') or 0) <= 900):
            continue
        if nt == nq:
            score = 100
        elif na and nt in nq and na in nq:
            score = 95
        elif nq in nt:
            score = 70 - min(20, len(nt) - len(nq))
        elif nt in nq and len(nt) >= 2:
            score = 55
        else:
            continue
        if FLAVOR.search(t) and not want_flavor:
            score -= 30
        score += min(15, 3 * (fame.get((nt, na), 1) - 1))
        if (r.get('duration') or 0) < 120:
            score -= 10  # 不到两分钟的多是片段、试听
        if is_chinese(t + a):
            score += 3
        if score >= 50:
            out.append((score, r))
    out.sort(key=lambda x: -x[0])
    return [r for _, r in out]

async def search_audio(q, allowed, limit=150):
    out = []
    async for msg in user_client.iter_messages(None, search=q[:64], filter=InputMessagesFilterMusic, limit=limit):
        chat, f = msg.chat, msg.file
        if not f or (getattr(chat, 'username', None) or '').lower() not in allowed:
            continue
        out.append({'channel': chat.username, 'id': msg.id, 'title': f.title or f.name or '', 'performer': f.performer or '',
                    'duration': f.duration or 0})
    return out

async def fulfill_request(q, chat_id, allowed, existing, link):
    try:
        ranked = rank_requests(q, await search_audio(q, allowed))
        have = {song_key(t, a) for t, a in existing}
        for r in ranked[:4]:
            t, a = clean_names(r['title'], r['performer'])
            name = f'{a} - {t}' if a else t
            if song_key(r['title'], r['performer']) in have:
                await bot_say(chat_id, f'🎵 「{name}」已经在小橘音乐里了，打开网页搜一下就能听：{link}')
                return
            try:
                msg = await user_client.get_messages(r['channel'], ids=r['id'])
                sent = await user_client.forward_messages(target_channel(), msg, drop_author=True)
            except ChatForwardsRestrictedError:
                continue  # 这个频道禁止转发，试下一首
            new_id = getattr(sent[0] if isinstance(sent, list) and sent else sent, 'id', None)
            await bot_say(chat_id, f'🎵 找到了：{name}\n已经放进小橘音乐，点这里听：{link}#{new_id}')
            return
        await bot_say(chat_id, f'没找到「{q}」😢 换个写法、或者加上歌手名再试试')
    except Exception:  # noqa: BLE001
        log.exception('fulfill failed')
        await bot_say(chat_id, '找歌的时候出了点问题，过一会儿再试试')

@app.post('/fulfill')
async def fulfill(request: Request):
    """{q, chat_id, only: [来源频道], existing, link}。马上返回；找到（或没找到）后机器人直接回复 chat_id。"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    body = await request.json()
    q = str(body.get('q', '')).strip()[:60]
    if not q or not body.get('chat_id'):
        raise HTTPException(400, 'bad request')
    allowed = {str(c).strip().lstrip('@').lower() for c in body.get('only', []) if str(c).strip()}
    existing = [(str(t), str(a)) for t, a in body.get('existing', [])]
    asyncio.create_task(fulfill_request(q, body['chat_id'], allowed, existing, str(body.get('link', ''))[:200]))
    return {'ok': True}

@app.get('/search/channels')
async def search_channels(q: str, request: Request):
    """按名字搜公开频道（和 Telegram 里的全局搜索一样），给搬歌挑来源用。"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    found = await user_client(SearchRequest(q=q[:64], limit=30))
    return {'channels': [{'username': c.username, 'title': c.title, 'members': getattr(c, 'participants_count', None)}
                         for c in found.chats if getattr(c, 'broadcast', False) and c.username]}

@app.get('/search/music')
async def search_music(q: str, channels: str, request: Request):
    """在几个公开频道里按关键词搜音频（频道内搜索，不用加入），每个频道最多 20 条。"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    out = []
    for ch in [c.strip().lstrip('@') for c in channels.split(',') if c.strip()][:20]:
        try:
            async for msg in user_client.iter_messages(ch, search=q[:64], filter=InputMessagesFilterMusic, limit=20):
                f = msg.file
                if f:
                    out.append({'channel': ch, 'id': msg.id, 'title': f.title or f.name or '', 'performer': f.performer or '',
                                'duration': f.duration or 0, 'size': f.size or 0})
        except Exception as e:  # noqa: BLE001 — 频道不存在、禁止保存内容之类，跳过这个频道
            log.info('search %s in %s failed: %s', q, ch, e)
    return {'results': out}

@app.post('/channels/join')
async def channels_join(request: Request):
    """用频道主账号加入（关注）一批公开频道：{usernames: [...]}。加入后可以用 /search/global 一次搜遍。
    每个隔几秒，Telegram 叫等就等（超过 10 分钟就停下，剩下的标成 flood）。"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    names = [str(u).strip().lstrip('@') for u in (await request.json()).get('usernames', [])][:50]

    async def join(name):
        await user_client(JoinChannelRequest(name))
        # 静音、收进「已归档」：几十个频道不该刷屏、响通知，搜索照样搜得到
        await user_client(UpdateNotifySettingsRequest(peer=name, settings=InputPeerNotifySettings(mute_until=2**31 - 1)))
        await user_client.edit_folder(name, 1)

    result = {}
    for name in names:
        if not re.fullmatch(r'\w{4,64}', name):
            result[name] = 'bad name'
            continue
        try:
            await join(name)
            result[name] = 'joined'
        except FloodWaitError as e:
            if e.seconds > 600:
                result[name] = f'flood {e.seconds}s'
                break
            await asyncio.sleep(e.seconds + 1)
            try:
                await join(name)
                result[name] = 'joined'
            except Exception as e2:  # noqa: BLE001
                result[name] = type(e2).__name__
        except Exception as e:  # noqa: BLE001 — 频道不存在、私有之类
            result[name] = type(e).__name__
        await asyncio.sleep(5)
    return {'result': result}

MUSIC_WORDS = re.compile(r'音乐|歌|曲|dj|无损|music|musik|muzik|flac|mp3|电音|bass|说唱|rap|hip.?hop|唱片|听', re.I)

@app.post('/channels/archive-music')
async def channels_archive_music(request: Request):
    """把频道主账号聊天列表里名字像音乐的群和频道收进「已归档」并静音（不静音的话来新消息会自己跳出来）。
    只看名字，别的聊天不碰、也不列出来。{dry_run: true} 只返回会动到哪些。"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    body = await request.json()
    dry = bool(body.get('dry_run'))
    also = {str(u).strip().lstrip('@').lower() for u in body.get('also', [])}  # 名字不像、但在来源名单里的音乐频道
    done = []
    async for d in user_client.iter_dialogs(archived=False):
        e = d.entity
        is_group_or_channel = getattr(e, 'broadcast', False) or getattr(e, 'megagroup', False) or d.is_group
        name = (getattr(e, 'username', None) or '').lower()
        if not is_group_or_channel or not (MUSIC_WORDS.search(d.title or '') or name in also):
            continue
        if (getattr(e, 'username', None) or '').lower() == target_channel().lower():
            continue  # 小橘音乐自己不动
        done.append(d.title)
        if not dry:
            await user_client(UpdateNotifySettingsRequest(peer=e, settings=InputPeerNotifySettings(mute_until=2**31 - 1)))
            await user_client.edit_folder(e, 1)
            await asyncio.sleep(1)
    return {'archived' if not dry else 'would_archive': done}

@app.post('/channels/check')
async def channels_check(request: Request):
    """核对一批候选频道：在不在、是不是频道、多少人、最近 200 条里有几首音频。{usernames: [...]}"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    out = {}
    for name in [str(u).strip().lstrip('@') for u in (await request.json()).get('usernames', [])][:60]:
        try:
            e = await user_client.get_entity(name)
            if not getattr(e, 'broadcast', False):
                out[name] = {'ok': False, 'why': 'not a channel'}
                continue
            audio = 0
            async for _ in user_client.iter_messages(e, filter=InputMessagesFilterMusic, limit=200):
                audio += 1
            out[name] = {'ok': True, 'username': e.username, 'title': e.title, 'members': getattr(e, 'participants_count', None),
                         'audio': audio, 'noforwards': bool(getattr(e, 'noforwards', False))}
        except FloodWaitError as e:
            out[name] = {'ok': False, 'why': f'flood {e.seconds}s'}
            break
        except Exception as e:  # noqa: BLE001
            out[name] = {'ok': False, 'why': type(e).__name__}
        await asyncio.sleep(1.5)
    return {'channels': out}

@app.get('/search/global')
async def search_global(q: str, only: str, request: Request, limit: int = 100):
    """一次搜遍频道主账号加入的频道里的音频（Telegram 的全局消息搜索，只搜音乐），
    只留 only（逗号分隔的「音乐来源频道」名单）里的频道：账号自己关注的别的频道不掺进来。"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    allowed = {c.strip().lstrip('@').lower() for c in only.split(',') if c.strip()}
    out = []
    async for msg in user_client.iter_messages(None, search=q[:64], filter=InputMessagesFilterMusic, limit=max(1, min(limit, 300))):
        chat = msg.chat
        f = msg.file
        if not f or (getattr(chat, 'username', None) or '').lower() not in allowed:
            continue
        out.append({'channel': chat.username, 'id': msg.id, 'title': f.title or f.name or '', 'performer': f.performer or '',
                    'duration': f.duration or 0, 'size': f.size or 0})
    return {'results': out}

@app.post('/bot/ask')
async def bot_ask(request: Request):
    """以频道主账号给搜索机器人（比如 @jisou）发一句话，等它回复，把回复文字和里面的 t.me 链接拿回来。
    {bot, text, wait?} → {replies: [文字], links: [用户名]}"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    body = await request.json()
    bot = str(body.get('bot', '')).strip().lstrip('@')
    if not re.fullmatch(r'\w{4,64}', bot):
        raise HTTPException(400, 'bad bot')
    sent = await user_client.send_message(bot, str(body.get('text', ''))[:200])
    await asyncio.sleep(max(2, min(int(body.get('wait', 6)), 20)))
    replies, links, hits = [], [], []
    async for m in user_client.iter_messages(bot, min_id=sent.id, limit=10):
        if m.out:
            continue
        text = m.raw_text or ''
        replies.append(text)
        urls = re.findall(r't\.me/\S+', text)
        # 结果列表里每一行的文字和它指向的消息链接：{text: 这一行, url: t.me/频道/消息号}
        for e, inner in m.get_entities_text():
            url = getattr(e, 'url', None)
            if url:
                urls.append(url)
                hit = re.search(r't\.me/(?:s/)?([A-Za-z]\w{3,})/(\d+)', url)
                if hit:
                    hits.append({'text': inner, 'channel': hit[1], 'id': int(hit[2])})
        for row in (m.buttons or []):
            for b in row:
                urls.append(getattr(b, 'url', None) or '')
        for u in urls:
            name = re.search(r't\.me/(?:s/)?([A-Za-z]\w{3,})', u)
            if name and name[1] not in links:
                links.append(name[1])
    return {'replies': replies, 'links': links, 'hits': hits}

@app.post('/copy/photos')
async def copy_photos(request: Request):
    """把一个频道最新的图片帖转到小橘音乐（不带「转发自」，说明文字原样保留，画师署名不丢）。
    Worker 会把频道里的图片帖记下来，给没有封面的歌当封面。{source, limit} → {new_ids, skipped}"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    body = await request.json()
    source = str(body.get('source', '')).strip().lstrip('@')
    if not re.fullmatch(r'\w{4,64}', source):
        raise HTTPException(400, 'bad source')
    limit = max(1, min(int(body.get('limit', 30)), 200))
    skip = max(0, int(body.get('skip', 0)))  # 跳过最新的几张（上一批已经转过）
    new_ids, skipped = [], 0
    async for msg in user_client.iter_messages(source, filter=InputMessagesFilterPhotos, limit=limit, add_offset=skip):
        try:
            sent = await user_client.forward_messages(target_channel(), msg, drop_author=True)
            new_ids.append(getattr(sent[0] if isinstance(sent, list) else sent, 'id', None))
        except FloodWaitError as e:
            if e.seconds > 600:
                break
            await asyncio.sleep(e.seconds + 1)
            skipped += 1
        except Exception as e:  # noqa: BLE001 — 比如来源频道禁止转发
            log.info('photo %s failed: %s', msg.id, e)
            skipped += 1
        await asyncio.sleep(3)
    return {'new_ids': new_ids, 'skipped': skipped}

@app.post('/copy/pick')
async def copy_pick(request: Request):
    """把挑好的几条转到小橘音乐：{items: [{channel, id}]}，返回每条转过去后的新消息号（失败为 null）。"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    items = (await request.json()).get('items', [])[:50]
    done = []
    for it in items:
        try:
            # 只转音频：搜索机器人给的链接可能指向别的东西
            msg = await user_client.get_messages(str(it['channel']), ids=int(it['id']))
            if msg is None or msg.file is None or not (msg.file.mime_type or '').startswith('audio/'):
                done.append(None)
                continue
            sent = await user_client.forward_messages(target_channel(), msg, drop_author=True)
            done.append(getattr(sent[0] if isinstance(sent, list) else sent, 'id', None))
        except Exception as e:  # noqa: BLE001
            log.info('pick %s failed: %s', it, e)
            done.append(None)
        await asyncio.sleep(3)
    return {'new_ids': done}

@app.get('/copy/status')
async def copy_status(request: Request):
    check_key(request)
    return {'logged_in': copier is not None, **(copier.state if copier else {'status': 'idle'})}

@app.post('/copy/stop')
async def copy_stop(request: Request):
    check_key(request)
    if copier:
        copier.stop()
    return {'ok': True}
