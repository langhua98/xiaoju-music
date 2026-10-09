"""流式服务的本地测试：假的 Telegram（取消息 + MTProto 分块下载），不联网。

    pip install -r requirements.txt pytest httpx && python -m pytest -q
"""

import asyncio

import pytest
from fastapi.testclient import TestClient
from telethon.errors import FileReferenceExpiredError, FloodWaitError, SessionPasswordNeededError

import app as appmod
from app import CHUNK, Streamer, parse_range

DATA = bytes((i * 7 + (i >> 12)) & 255 for i in range(CHUNK * 3 + 12345))  # 3 块多一点


class Doc:
    mime_type = 'audio/mpeg'

    def __init__(self, size, ref):
        self.size = size
        self.ref = ref


class Msg:
    def __init__(self, doc):
        self.document = doc


class FakeTelegram:
    """模拟 Telethon：按 512 KB 对齐的偏移分块下载；可以让第一次取到的文件引用在某个位置过期。"""

    def __init__(self, expire_at=None):
        self.fetches = 0
        self.offsets = []
        self.served = 0
        self.closed = 0
        self.expire_at = expire_at

    async def fetch_message(self, channel, message_id):
        assert channel == 'xiaojumusic'
        self.fetches += 1
        return Msg(Doc(len(DATA), self.fetches)) if message_id == 12 else None

    def iter_download(self, doc, *, offset, request_size, file_size):
        assert offset % CHUNK == 0 and request_size == CHUNK and file_size == len(DATA)
        self.offsets.append(offset)

        async def gen():
            try:
                pos = offset
                while pos < len(DATA):
                    if self.expire_at is not None and pos >= self.expire_at and doc.ref == 1:
                        raise FileReferenceExpiredError(request=None)
                    chunk = DATA[pos:pos + request_size]
                    self.served += len(chunk)
                    yield chunk
                    pos += len(chunk)
            finally:
                self.closed += 1

        return gen()


def collect(streamer, start, end):
    async def main():
        return b''.join([c async for c in streamer.body(12, start, end)])
    return asyncio.run(main())


def make(tg, **kw):
    return Streamer(channel='xiaojumusic', fetch_message=tg.fetch_message, iter_download=tg.iter_download, **kw)


def test_parse_range():
    n = 1000
    assert parse_range(None, n) == (0, 999, False)
    assert parse_range('bytes=0-1', n) == (0, 1, True)
    assert parse_range('bytes=990-', n) == (990, 999, True)
    assert parse_range('bytes=-10', n) == (990, 999, True)
    assert parse_range('bytes=500-5000', n) == (500, 999, True)
    assert parse_range('bytes=1000-', n) is None
    assert parse_range('bytes=-0', n) is None
    assert parse_range('bytes=0-1,5-6', n) == (0, 999, False)
    assert parse_range('bytes=9-3', n) == (0, 999, False)


@pytest.mark.parametrize('start,end', [
    (0, 1),
    (CHUNK - 3, CHUNK + 2),          # 跨一个块边界
    (CHUNK + 100, 3 * CHUNK + 50),   # 从块中间开始，跨两个边界
    (len(DATA) - 7, len(DATA) - 1),  # 最后几个字节
    (0, len(DATA) - 1),              # 整个文件
])
def test_body_returns_exact_bytes_from_aligned_offsets(start, end):
    tg = FakeTelegram()
    assert collect(make(tg), start, end) == DATA[start:end + 1]
    assert tg.offsets == [start - start % CHUNK]
    # 不多下：最多比要的多出两个块的零头
    assert tg.served <= (end - start + 1) + 2 * CHUNK
    assert tg.closed == 1


def test_expired_file_reference_is_refetched_and_resumed():
    tg = FakeTelegram(expire_at=2 * CHUNK)
    start = CHUNK - 10
    assert collect(make(tg), start, len(DATA) - 1) == DATA[start:]
    assert tg.fetches == 2
    assert tg.offsets == [0, 2 * CHUNK]
    assert tg.closed == 2


def test_gives_up_after_repeated_expiry():
    tg = FakeTelegram(expire_at=0)
    tg.fetch_message = _always_stale(tg)
    with pytest.raises(FileReferenceExpiredError):
        collect(make(tg), 0, 10)
    assert tg.fetches == 1 + appmod.MAX_REFRESHES


def _always_stale(tg):
    async def fetch(channel, message_id):
        tg.fetches += 1
        return Msg(Doc(len(DATA), 1))  # 每次拿到的都是会过期的引用
    return fetch


def test_a_failing_close_does_not_hide_the_real_error():
    class Broken:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise ConnectionError('telegram went away')

        async def close(self):
            raise AttributeError('_sender')  # Telethon 没取过数据就关，就是这样

    tg = FakeTelegram()
    s = Streamer(channel='xiaojumusic', fetch_message=tg.fetch_message, iter_download=lambda *a, **kw: Broken())
    with pytest.raises(ConnectionError):
        collect(s, 0, 10)


def test_messages_are_cached_until_ttl():
    tg = FakeTelegram()
    now = [0.0]
    s = make(tg, clock=lambda: now[0])
    collect(s, 0, 1)
    collect(s, 5, 9)
    assert tg.fetches == 1
    now[0] += appmod.MESSAGE_TTL + 1
    collect(s, 0, 1)
    assert tg.fetches == 2


def test_http_endpoint(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    tg = FakeTelegram()
    monkeypatch.setattr(appmod, 'streamer', make(tg))
    client = TestClient(appmod.app)  # 不进 with，就不会触发登录 Telegram 的 lifespan
    assert client.get('/').json() == {'ok': True}
    assert client.get('/stream/12').status_code == 403
    assert client.get('/stream/12', headers={'X-Key': 'wrong'}).status_code == 403
    key = {'X-Key': 'k1'}
    assert client.get('/stream/99', headers=key).status_code == 404

    r = client.get('/stream/12', headers={**key, 'Range': f'bytes={CHUNK - 5}-{CHUNK + 4}'})
    assert r.status_code == 206
    assert r.headers['content-range'] == f'bytes {CHUNK - 5}-{CHUNK + 4}/{len(DATA)}'
    assert r.headers['content-length'] == '10'
    assert r.content == DATA[CHUNK - 5:CHUNK + 5]

    r = client.get('/stream/12', headers=key)
    assert r.status_code == 200 and r.content == DATA
    assert r.headers['content-length'] == str(len(DATA))

    r = client.get('/stream/12', headers={**key, 'Range': f'bytes={len(DATA)}-'})
    assert r.status_code == 416 and r.headers['content-range'] == f'bytes */{len(DATA)}'


def test_thumbnail_endpoint(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    jpeg = b'\xff\xd8\xff\xe0' + b'x' * 100
    downloaded = []

    class WithThumbs(FakeTelegram):
        async def fetch_message(self, channel, message_id):
            msg = await super().fetch_message(channel, message_id)
            if msg is not None and message_id == 12:
                msg.document.thumbs = ['320x320']
            return msg

    async def download_thumb(msg):
        downloaded.append(msg)
        return jpeg

    tg = WithThumbs()
    monkeypatch.setattr(appmod, 'streamer', Streamer(channel='xiaojumusic', fetch_message=tg.fetch_message,
                                                     iter_download=tg.iter_download, download_thumb=download_thumb))
    client = TestClient(appmod.app)
    assert client.get('/thumb/12').status_code == 403
    r = client.get('/thumb/12', headers={'X-Key': 'k1'})
    assert r.status_code == 200 and r.content == jpeg and r.headers['content-type'] == 'image/jpeg'
    assert client.get('/thumb/99', headers={'X-Key': 'k1'}).status_code == 404  # 没有这条消息
    assert len(downloaded) == 1


def test_thumbnail_missing_when_file_has_none():
    tg = FakeTelegram()  # Doc 没有 thumbs 属性

    async def never(msg):
        raise AssertionError('should not download')

    s = Streamer(channel='xiaojumusic', fetch_message=tg.fetch_message, iter_download=tg.iter_download, download_thumb=never)
    assert asyncio.run(s.thumbnail(12)) is None


def test_client_never_subscribes_to_updates(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, session, api_id, api_hash, **kw):
            seen.update(api_id=api_id, api_hash=api_hash, **kw)

    monkeypatch.setattr(appmod, 'TelegramClient', FakeClient)
    appmod.make_client({'TG_API_ID': '123', 'TG_API_HASH': 'abc'})
    assert seen == {'api_id': 123, 'api_hash': 'abc', 'receive_updates': False}


def test_photo_scan_and_download(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')

    class M:
        def __init__(self, i, photo):
            self.id = i
            self.photo = photo

    calls = []

    async def fetch_message(channel, ids):
        calls.append(ids)
        if isinstance(ids, list):
            return [M(i, 'P' if i % 50 == 0 else None) if i <= 180 else None for i in ids]
        return M(ids, 'P') if ids == 50 else None

    async def download_photo(msg):
        return b'\xff\xd8img' + str(msg.id).encode()

    s = Streamer(channel='xiaojumusic', fetch_message=fetch_message, iter_download=None, download_photo=download_photo)
    monkeypatch.setattr(appmod, 'streamer', s)
    client = TestClient(appmod.app)
    assert client.get('/photos?upto=250').status_code == 403
    r = client.get('/photos?upto=250', headers={'X-Key': 'k1'})
    assert r.json() == {'photos': [50, 100, 150]}
    assert [len(c) for c in calls] == [100, 100, 50]
    client.get('/photos?upto=200', headers={'X-Key': 'k1'})
    assert len(calls) == 3  # 缓存命中
    r = client.get('/photo/50', headers={'X-Key': 'k1'})
    assert r.status_code == 200 and r.content == b'\xff\xd8img50'
    assert client.get('/photo/51', headers={'X-Key': 'k1'}).status_code == 404


# ── 搬歌 ──

def run_copier(songs, existing=(), limit=100, dry_run=False, flood_on=None, **rule):
    forwarded, slept = [], []

    async def iter_music(source, min_id=0):
        assert source == 'VmoMusic' and min_id == 0
        for s in songs:
            yield s, s[0], s[1], (s[2] if len(s) > 2 else 200)

    class Sent:
        def __init__(self, i):
            self.id = i

    async def forward(target, msg):
        assert target == 'xiaojumusic'
        if flood_on == msg[0] and not slept:
            raise FloodWaitError(request=None, capture=7)
        forwarded.append(msg[0])
        return [Sent(1000 + len(forwarded))]  # Telethon 返回转过去的新消息

    async def sleep(n):
        slept.append(n)

    async def main():
        c = appmod.Copier(iter_music=iter_music, forward=forward, sleep=sleep, pause=3)
        c.start('VmoMusic', 'xiaojumusic', limit, list(existing), dry_run, **rule)
        await c.task
        return c.state

    return asyncio.run(main()), forwarded, slept


def test_copier_keywords_duration_and_any_language():
    songs = [('夜曲 DJ版', '某人', 200), ('Destructure (Bass Mix)', 'DJ X', 180), ('晴天', '周杰伦', 260),
             ('重低音车载', '', 40), ('慢摇串烧', '', 3000)]
    state, forwarded, _ = run_copier(songs, keywords=['dj', '重低音', 'mix', '慢摇'], min_seconds=90, chinese_only=False)
    assert forwarded == ['夜曲 DJ版', 'Destructure (Bass Mix)', '慢摇串烧']
    assert state['skipped_other'] == 2  # 「晴天」没有关键词，「重低音车载」只有 40 秒
    assert state['new_ids'] == [1001, 1002, 1003]


def test_copier_takes_chinese_songs_skips_duplicates_and_stops_at_limit():
    songs = [('晴天', '周杰伦 @VmoMusic'), ('Shape of You', 'Ed Sheeran'), ('周杰伦 - 晴天', ''),
             ('稻香', '周杰伦'), ('江南', '林俊杰'), ('マリーゴールド', 'あいみょん'), ('사랑', '아이유'),
             ('小情歌', '苏打绿'), ('夜曲', '周杰伦')]
    state, forwarded, slept = run_copier(songs, existing=[('江南', '林俊杰')], limit=3)
    assert forwarded == ['晴天', '稻香', '小情歌']
    assert state['status'] == 'done' and state['copied'] == 3
    assert state['skipped_dup'] == 2 and state['skipped_lang'] == 3
    assert slept == [3, 3, 3]
    assert state['recent'][0] == '苏打绿 - 小情歌'


def test_copier_dry_run_forwards_nothing():
    state, forwarded, _ = run_copier([('晴天', '周杰伦')], dry_run=True)
    assert forwarded == [] and state['copied'] == 1


def test_copier_waits_out_flood_limits():
    state, forwarded, slept = run_copier([('晴天', '周杰伦'), ('稻香', '周杰伦')], flood_on='晴天')
    assert forwarded == ['晴天', '稻香'] and slept[0] == 8 and state['status'] == 'done'


def test_login_with_two_step_password():
    events = []

    class FakeUser:
        def __init__(self, session):
            self.session = session

        async def connect(self):
            events.append('connect')

        async def send_code_request(self, phone):
            events.append(('code', phone))

            class Sent:
                phone_code_hash = 'H'
            return Sent()

        async def sign_in(self, phone=None, code=None, phone_code_hash=None, password=None):
            events.append(('sign_in', code, phone_code_hash, password))
            if password is None:
                raise SessionPasswordNeededError(request=None)

    async def main():
        lg = appmod.Login(FakeUser)
        await lg.send_code('+15550100000')
        with pytest.raises(SessionPasswordNeededError):
            await lg.verify('12345')
        client = await lg.verify('12345', 'pw')  # 第二次只交密码，不再交验证码
        return client, lg

    client, lg = asyncio.run(main())
    assert isinstance(client, FakeUser) and lg.pending is None
    assert events == ['connect', ('code', '+15550100000'), ('sign_in', '12345', 'H', None), ('sign_in', None, None, 'pw')]


def test_copy_endpoints_need_key_and_login(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    monkeypatch.setattr(appmod, 'copier', None)
    client = TestClient(appmod.app)
    assert client.post('/copy/start', json={'source': 'VmoMusic'}).status_code == 403
    assert client.post('/copy/start', json={'source': 'VmoMusic'}, headers={'X-Key': 'k1'}).status_code == 409
    assert client.get('/copy/status', headers={'X-Key': 'k1'}).json() == {'logged_in': False, 'status': 'idle'}
    assert client.post('/login/code', json={'phone': 'abc'}, headers={'X-Key': 'k1'}).status_code == 400
    # 加入频道、全局搜索也要密钥和登录
    monkeypatch.setattr(appmod, 'user_client', None)
    assert client.post('/channels/join', json={'usernames': ['abcd']}).status_code == 403
    assert client.post('/channels/join', json={'usernames': ['abcd']}, headers={'X-Key': 'k1'}).status_code == 409
    assert client.get('/search/global?q=x&only=dj225', headers={'X-Key': 'k1'}).status_code == 409


# ── 音柱数据 ──

def tones(*parts, rate=appmod.VIZ_RATE):
    """拼一段测试音频：[(频率或 0 表示静音, 秒数), ...] → int16 采样"""
    import numpy as np
    out = []
    for hz, sec in parts:
        t = np.arange(int(rate * sec)) / rate
        out.append((np.sin(2 * np.pi * hz * t) * 12000 if hz else np.zeros_like(t)).astype('<i2'))
    return np.concatenate(out)


def band_of(hz):
    import numpy as np
    edges = np.geomspace(50, 5000, appmod.VIZ_BANDS + 1)
    return int(np.searchsorted(edges, hz) - 1)


def test_viz_levels_follow_the_music():
    lv = appmod.viz_levels(tones((100, 2), (3000, 2), (0, 1)))
    fps = appmod.VIZ_FPS
    assert lv.shape == (5 * fps, appmod.VIZ_BANDS)
    lo, hi = band_of(100), band_of(3000)
    first, second, quiet = lv[3:2 * fps - 3], lv[2 * fps + 3:4 * fps - 3], lv[4 * fps + 3:]
    # 低音那两秒：低频柱子满、高频几乎没有；换成高音后反过来；静音时全部落到底
    assert first[:, lo].min() >= 12 and first[:, hi].max() <= 3
    assert second[:, hi].min() >= 12 and second[:, lo].max() <= 3
    assert quiet.max() == 0


def test_pack_viz_header_and_nibbles():
    import numpy as np
    lv = np.array([[1, 2, 3], [15, 0, 7], [4, 5, 6]], np.uint8)
    b = appmod.pack_viz(lv, fps=15)
    assert b[:5] == b'XV' + bytes([1, 15, 3])
    body = b[5:]
    vals = [v for byte in body for v in (byte >> 4, byte & 15)]
    assert vals[:9] == [1, 2, 3, 15, 0, 7, 4, 5, 6] and len(body) == 5


def test_viz_endpoint(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    tg = FakeTelegram()
    monkeypatch.setattr(appmod, 'streamer', make(tg))
    seen = {}

    def fake_decode(data):
        seen['bytes'] = data
        return tones((100, 1), (3000, 1))

    monkeypatch.setattr(appmod, 'decode_pcm', fake_decode)
    client = TestClient(appmod.app)
    assert client.get('/viz/12').status_code == 403
    key = {'X-Key': 'k1'}
    assert client.get('/viz/99', headers=key).status_code == 404
    r = client.get('/viz/12', headers=key)
    assert r.status_code == 200 and r.content[:5] == b'XV' + bytes([1, appmod.VIZ_FPS, appmod.VIZ_BANDS])
    assert seen['bytes'] == DATA  # 整个文件都取下来交给 ffmpeg
    assert len(r.content) == 5 + 2 * appmod.VIZ_FPS * appmod.VIZ_BANDS // 2
    monkeypatch.setattr(appmod, 'decode_pcm', lambda data: None)  # 解不出来（不是能识别的音频）
    assert client.get('/viz/12', headers=key).status_code == 404



# ── 夜里自动搬、通知、求歌 ──

class Post:
    """假的频道帖子：消息号 + (歌名, 歌手, 秒数)"""
    def __init__(self, id, title, performer='', seconds=200):
        self.id, self.title, self.performer, self.seconds = id, title, performer, seconds


def run_auto(channels, sources, existing=(), protected=(), broken=(), **kw):
    """channels: {频道: [Post, ...]（新的在前）}"""
    forwarded, said, asked = [], [], []

    async def iter_music(source, min_id=0):
        asked.append((source, min_id))
        if source in broken:
            raise RuntimeError('boom')
        for p in channels[source]:
            if p.id > min_id:
                yield p, p.title, p.performer, p.seconds

    async def forward(target, msg):
        if any(msg in channels[c] for c in protected):
            raise appmod.ChatForwardsRestrictedError(request=None)
        forwarded.append(msg.title)
        return msg

    async def say(chat, text):
        said.append((chat, text))

    async def sleep(n):
        pass

    async def main():
        c = appmod.Copier(iter_music=iter_music, forward=forward, say=say, sleep=sleep)
        c.start_auto(sources, 'xiaojumusic', list(existing), notify=42, run_id='r1', **kw)
        await c.task
        return c.state

    return asyncio.run(main()), forwarded, said, asked


def test_auto_copies_only_new_posts_and_remembers_where_it_stopped():
    channels = {
        'old_ch': [Post(105, '新歌甲', '歌手A'), Post(104, '新歌乙', '歌手B'), Post(100, '老歌', '歌手C')],
        'new_ch': [Post(30 - i, f'第{i}首', '某人') for i in range(10)],
        'prot_ch': [Post(9, '锁住的歌', '某人')],
        'dj_ch': [Post(7, '两小时串烧', 'DJ', 7200), Post(6, '片段', '', 20), Post(5, 'English Song', 'X')],
    }
    sources = {'old_ch': 100, 'new_ch': 0, 'prot_ch': 0, 'dj_ch': 0, 'broken_ch': 3}
    channels['broken_ch'] = []
    st, forwarded, said, asked = run_auto(channels, sources, existing=[('新歌乙', '歌手B')],
                                          protected=['prot_ch'], broken=['broken_ch'], first_time=3)
    assert ('old_ch', 100) in asked and ('new_ch', 0) in asked  # 只看上次之后的帖子
    assert forwarded == ['新歌甲', '第0首', '第1首', '第2首']  # 重复的、第一次多于 3 首的、串烧、片段、外语都不搬
    assert st['status'] == 'done' and st['copied'] == 4
    assert st['sources']['old_ch'] == {'max_id': 105, 'copied': 1, 'error': ''}
    assert st['sources']['new_ch']['max_id'] == 30
    assert st['sources']['prot_ch']['error'] == 'protected'
    assert st['sources']['broken_ch']['error'].startswith('RuntimeError') and st['sources']['broken_ch']['max_id'] == 3
    (chat, text), = said
    assert chat == 42 and '新增 4 首' in text and '@new_ch：3 首' in text and '@broken_ch' in text and 'prot_ch' not in text


def test_single_copy_notifies_when_done_or_protected():
    channels = {'a_ch': [Post(2, '晴天', '周杰伦')], 'p_ch': [Post(1, '稻香', '周杰伦')]}
    said = []

    async def iter_music(source, min_id=0):
        for p in channels[source]:
            yield p, p.title, p.performer, p.seconds

    async def forward(target, msg):
        if msg in channels['p_ch']:
            raise appmod.ChatForwardsRestrictedError(request=None)
        return msg

    async def say(chat, text):
        said.append(text)

    async def sleep(n):
        pass

    async def main():
        c = appmod.Copier(iter_music=iter_music, forward=forward, say=say, sleep=sleep)
        c.start('a_ch', 't', 10, [], notify=7)
        await c.task
        c.start('p_ch', 't', 10, [], notify=7)
        await c.task
        return c.state

    st = asyncio.run(main())
    assert '从 @a_ch 搬了 1 首' in said[0] and '周杰伦 - 晴天' in said[0]
    assert '禁止转发' in said[1] and st['error'] == 'protected'


def test_request_ranking_prefers_the_plain_song():
    res = [
        {'title': '晴天 (DJ版)', 'performer': '周杰伦', 'duration': 200},
        {'title': '晴天', 'performer': '周杰伦', 'duration': 269},
        {'title': '晴天娃娃', 'performer': '某人', 'duration': 200},
        {'title': '晴天', 'performer': '周杰伦', 'duration': 30},      # 片段
        {'title': '雨天', 'performer': '某人', 'duration': 200},       # 不相干
    ]
    ranked = appmod.rank_requests('晴天', res)
    assert [r['title'] for r in ranked] == ['晴天', '晴天娃娃']  # DJ 版被扣分到 40，不要
    # 「歌名 歌手」也能对上
    assert appmod.rank_requests('周杰伦 晴天', res)[0]['title'] == '晴天'
    assert appmod.rank_requests('晴天 dj版', res)[0]['title'] == '晴天 (DJ版)'


def test_auto_and_fulfill_endpoints_need_key_and_login(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    monkeypatch.setattr(appmod, 'copier', None)
    monkeypatch.setattr(appmod, 'user_client', None)
    client = TestClient(appmod.app)
    assert client.post('/auto/start', json={}).status_code == 403
    assert client.post('/auto/start', json={}, headers={'X-Key': 'k1'}).status_code == 409
    assert client.get('/auto/status', headers={'X-Key': 'k1'}).json() == {'status': 'idle'}
    assert client.post('/fulfill', json={'q': 'x', 'chat_id': 1}, headers={'X-Key': 'k1'}).status_code == 409


def test_request_ranking_prefers_the_artist_most_channels_have():
    res = [{'title': '发如雪', 'performer': '小黑', 'duration': 180}]
    res += [{'title': '发如雪', 'performer': '周杰伦', 'duration': 299} for _ in range(4)]
    res += [{'title': '发如雪', 'performer': '某人', 'duration': 70}]
    assert appmod.rank_requests('发如雪', res)[0]['performer'] == '周杰伦'
    assert appmod.rank_requests('发如雪', res)[-1]['performer'] == '某人'


def test_music_prefixed_settings_win(monkeypatch):
    # 和小橘视频合用 Space：不带前缀的是视频的，音乐的存在 MUSIC_ 开头的名字下
    monkeypatch.setenv('STREAMER_KEY', 'video-key')
    monkeypatch.setenv('MUSIC_STREAMER_KEY', 'music-key')
    monkeypatch.setenv('TG_BOT_TOKEN', 'video-bot')
    monkeypatch.setenv('MUSIC_TG_BOT_TOKEN', 'music-bot')
    monkeypatch.setenv('TG_API_ID', '1')
    monkeypatch.delenv('MUSIC_TG_CHANNEL', raising=False)
    monkeypatch.delenv('TG_CHANNEL', raising=False)
    env = appmod.settings()
    assert env['TG_BOT_TOKEN'] == 'music-bot' and env['TG_API_ID'] == '1'
    assert appmod.target_channel() == appmod.PeerChannel(3817921075), '默认是小橘🍊音乐（私密频道）的 id'
    monkeypatch.setenv('MUSIC_TG_CHANNEL', '@xiaoju_test')
    assert appmod.target_channel() == 'xiaoju_test'
    monkeypatch.setenv('MUSIC_TG_CHANNEL', '-1001234')
    assert appmod.target_channel() == appmod.PeerChannel(1234)
    assert appmod.is_target_channel(type('E', (), {'id': 1234, 'username': None})())
    assert not appmod.is_target_channel(type('E', (), {'id': 99, 'username': 'x'})())
    monkeypatch.delenv('MUSIC_TG_CHANNEL')
    monkeypatch.setattr(appmod, 'streamer', make(FakeTelegram()))
    client = TestClient(appmod.app)
    assert client.get('/stream/12', headers={'X-Key': 'video-key'}).status_code == 403
    assert client.get('/stream/12', headers={'X-Key': 'music-key'}).status_code == 200


def test_self_check_reports_a_homepage_with_no_hot_songs(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    asked = []

    class Http:
        def __init__(self, **kw):
            pass

        async def get_json(self, url, params=None):
            path = url.split('3017', 1)[1]
            asked.append((path, (params or {}).get('cookie')))
            if path == '/user/account':
                return {'code': 200, 'profile': {'nickname': '小橘'}, 'account': {'vipType': 11}}
            return {'code': 200, 'songs': []}  # 网易云给了 0 首

    monkeypatch.setattr(appmod, 'Http', Http)
    monkeypatch.setattr(appmod, 'user_client', None)
    r = TestClient(appmod.app).post('/netease/check', headers={'X-Key': 'k1'},
                                    json={'cookie': 'MUSIC_U=x', 'alts': ['https://music.163.com/#/artist?id=9']}).json()
    assert r['login'] and r['songs'] == []
    assert r['error'] == '小号主页没取到热门歌（网易云给了 0 首）'
    assert ('/artist/top/song', 'MUSIC_U=x') in asked, '拉热门歌带上登录 cookie'
