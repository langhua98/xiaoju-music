"""贴网址搬自己的歌的测试：假的网易云接口和发帖，不联网。"""

import asyncio

import pytest
from fastapi.testclient import TestClient

import app as appmod
from harvest.job import Harvester
from harvest.sites import NetEase, Track, find_adapter
from harvest.upload import OWN, UploadError, caption, publish

SETTINGS = {'sites': ['netease'], 'limit': 10}


# ── 网站适配器 ──

class FakeHttp:
    def __init__(self, pages, blobs=None, redirects=None):
        self.pages, self.blobs, self.redirects, self.asked = pages, blobs or {}, redirects or {}, []

    async def final_url(self, url):
        return self.redirects[url]

    async def get_json(self, url, params=None):
        key = url + ('?' + '&'.join(f'{k}={v}' for k, v in sorted(params.items())) if params else '')
        self.asked.append(key)
        for k, v in self.pages.items():
            if key.startswith(k):
                return v
        raise AssertionError('unexpected ' + key)

    async def get_bytes(self, url, max_bytes):
        return self.blobs[url]


def collect(adapter, url, http, limit=10):
    async def main():
        return [t async for t in adapter.items(url, limit, http)]
    return asyncio.run(main())


def test_find_adapter():
    for u in ('https://music.163.com/#/song?id=1', 'https://y.music.163.com/m/song?id=1&uct2=x', 'https://163cn.tv/abc'):
        assert find_adapter(u).key == 'netease', u
    for u in ('https://archive.org/details/x', 'https://music.example.com/song/1', 'https://notmusic.163.com.evil.example/song?id=1'):
        assert find_adapter(u) is None, u


NE = 'https://music.163.com/api'


def ne_song(i, name, artists, ms=200000):
    return {'id': i, 'name': name, 'artists': [{'name': a} for a in artists], 'duration': ms}


def test_netease_song_album_playlist_artist_and_short_link():
    pages = {
        NE + '/song/detail/?ids=%5B11%5D': {'songs': [ne_song(11, '晴天', ['小橘', '朋友'])]},
        NE + '/album/5': {'album': {'songs': [ne_song(21, '一', ['小橘']), ne_song(22, '二', ['小橘'])]}},
        NE + '/v6/playlist/detail?id=7': {'playlist': {'trackIds': [{'id': 31}, {'id': 32}, {'id': 33}]}},
        NE + '/song/detail/?ids=%5B31%2C+32%5D': {'songs': [ne_song(31, '甲', ['A']), ne_song(32, '乙', ['B'])]},
        NE + '/v1/artist/songs?id=9&limit=50&offset=0': {'songs': [ne_song(41, '新歌', ['小橘'])], 'more': True},
        NE + '/v1/artist/songs?id=9&limit=50&offset=1': {'songs': [ne_song(42, '旧歌', ['小橘'])], 'more': False},
    }
    http = FakeHttp(pages, redirects={'https://163cn.tv/abc': 'https://y.music.163.com/m/song?id=11&uct2=x'})
    [t] = collect(NetEase(), 'https://music.163.com/#/song?id=11', http)
    assert (t.title, t.artist, t.duration, t.ext) == ('晴天', '小橘 / 朋友', 200.0, 'mp3')
    assert t.audio_url == 'https://music.163.com/song/media/outer/url?id=11.mp3'
    assert t.page_url == 'https://music.163.com/song?id=11'
    assert [x.title for x in collect(NetEase(), 'https://163cn.tv/abc', http)] == ['晴天']
    assert [x.title for x in collect(NetEase(), 'https://music.163.com/album?id=5', http)] == ['一', '二']
    assert [x.title for x in collect(NetEase(), 'https://music.163.com/#/playlist?id=7', http, limit=2)] == ['甲', '乙']
    assert [x.title for x in collect(NetEase(), 'https://music.163.com/#/artist?id=9', http)] == ['新歌', '旧歌']
    assert collect(NetEase(), 'https://music.163.com/#/discover', http) == []


# ── 上传 ──

def test_publish_converts_non_mp3_and_writes_source():
    t = Track('晴天', '小橘', 'https://u/x.flac', 'https://music.163.com/song?id=11', 0, 10, 'flac')
    sent = {}

    async def send(data, name, title, artist, seconds, text):
        sent.update(data=data, name=name, title=title, artist=artist, seconds=seconds, text=text)
        return 77

    async def main():
        return await publish(t, http=FakeHttp({}, {'https://u/x.flac': b'FLAC'}), send=send,
                             convert=lambda d: b'MP3:' + d, measure=lambda d: 196.4)
    assert asyncio.run(main()) == 77
    assert sent['data'] == b'MP3:FLAC' and sent['name'] == '小橘 - 晴天.mp3' and sent['seconds'] == 196
    assert sent['text'] == caption(t) == f'晴天 — 小橘\n授权：{OWN}\n来源：https://music.163.com/song?id=11'


def test_publish_refuses_huge_unconvertible_or_web_pages():
    big = Track('x', '', 'u', 'p', 0, 999 * 1024 * 1024, 'mp3')
    with pytest.raises(UploadError):
        asyncio.run(publish(big, http=FakeHttp({}), send=None))
    bad = Track('x', '', 'u', 'p', 0, 10, 'wav')
    with pytest.raises(UploadError):
        asyncio.run(publish(bad, http=FakeHttp({}, {'u': b'W'}), send=None, convert=lambda d: None))
    vip = Track('x', '', 'u', 'p', 0, 0, 'mp3')  # 网易云 VIP、下架的歌跳到 404 网页
    with pytest.raises(UploadError, match='网页不是音频'):
        asyncio.run(publish(vip, http=FakeHttp({}, {'u': b'  <!DOCTYPE html><html>404'}), send=None))


# ── 抓取 → 审核单 → 通过后发 ──

class Site:
    """假的网站：给定的歌"""
    key, name = 'netease', '假网站'

    def __init__(self, tracks):
        self.tracks = tracks

    async def items(self, url, limit, http):
        for t in self.tracks[:limit]:
            yield t


def run_job(tracks, settings=SETTINGS, existing=(), fail=(), then=None):
    """抓一次；then(h)：抓完以后接着做的事（比如按审核单的按钮），返回值放进 state['then']"""
    published, said = [], []

    async def fake_publish(t, *, http, send):
        if t.title in fail:
            raise UploadError('下载失败')
        published.append(t.title)
        return 100 + len(published)

    async def say(chat, text, buttons=None):
        said.append((text, buttons) if buttons else text)

    async def sleep(n):
        pass

    async def main():
        h = Harvester(http=None, send=None, say=say, sleep=sleep, publish_fn=fake_publish)
        site = Site([Track(*x) for x in tracks])
        h.check_url = lambda url, s: (site, None)
        h.start('https://music.163.com/#/artist?id=9', settings, list(existing), notify=9, link='https://w.example/')
        await h.task
        if then is None:
            return h.state
        out = await then(h)
        return {**h.state, 'then': out}

    return asyncio.run(main()), published, said


def test_crawling_only_fills_a_review_sheet():
    tracks = [('晴天', '小橘', 'u1', 'p1'), ('雨天', '别人', 'u2', 'p2'), ('旧歌', '小橘', 'u3', 'p3'),
              ('晴天', '小橘', 'u1b', 'p1b')]  # 同一页里重复的只进一次
    st, published, said = run_job(tracks, existing=[('旧歌', '小橘')])
    assert published == [], '抓取不发帖'
    assert st['review'] == 2 and st['skipped'] == 1 and st['copied'] == 0
    assert said[0].startswith('📥 从假网站抓到 2 首，等你审核（审核单另发），跳过 1 首') and '旧歌：小橘音乐里已经有了' in said[0]
    sheet, buttons = said[1]
    sid = st['review_id']
    assert sheet.startswith(f'🛂 审核单 {sid}（假网站，2 首，确认是不是我们的歌）')
    assert '· 晴天 — 小橘\n  p1' in sheet and '· 雨天 — 别人\n  p2' in sheet
    assert f'查看全部：https://w.example/harvest-review/{sid}' in sheet
    assert buttons == [[('✅ 审核通过', f'hv:ok:{sid}'), ('❌ 审核失败', f'hv:no:{sid}')]]


def test_approving_a_sheet_posts_its_tracks():
    tracks = [('甲', 'A', 'u1', 'p1'), ('乙', 'B', 'u2', 'p2'), ('丙', 'C', 'u3', 'p3'), ('丁', 'D', 'u4', 'p4')]

    async def approve(h):
        sid = h.state['review_id']
        info = h.sheet_info(sid)
        assert [t['title'] for t in info['tracks']] == ['甲', '乙', '丙', '丁'] and info['status'] == 'review'
        # 审核期间丙已经被别的方式搬进来了：通过时再查一次重
        assert h.decide(sid, True, [('丙', 'C')], notify=9) == ('approved', 4)
        await h.task
        assert h.decide(sid, True, [], notify=9) == ('done', 4)
        assert h.decide('nosuchsheet000', True, []) == ('missing', 0)
        return h.state

    st, published, said = run_job(tracks, then=approve, fail=['丁'])
    assert published == ['甲', '乙']
    assert st['then']['copied'] == 2 and st['then']['new_ids'] == [101, 102]
    assert said[-1].startswith('📥 审核通过的发进频道 2 首，没发 2 首')
    assert '· 甲 — A' in said[-1] and '丙：小橘音乐里已经有了' in said[-1] and '丁：下载失败' in said[-1]


def test_rejecting_a_sheet_posts_nothing():
    async def reject(h):
        sid = h.state['review_id']
        r = h.decide(sid, False, [])
        return r, h.sheet_info(sid)['status'], h.decide(sid, True, [])

    st, published, _ = run_job([('甲', 'A', 'u1', 'p1')], then=reject)
    assert published == [] and st['then'] == (('rejected', 1), 'rejected', ('done', 1))


def test_approval_waits_while_busy_and_the_limit_caps_the_sheet():
    tracks = [(f'歌{i}', 'A', 'u', 'p') for i in range(8)]

    async def busy(h):
        sid = h.state['review_id']
        h.task = asyncio.get_running_loop().create_future()  # 假装还在忙
        r = h.decide(sid, True, [])
        h.task.cancel()
        return r, h.sheet_info(sid)['status']

    st, published, _ = run_job(tracks, settings={'sites': ['netease'], 'limit': 3}, then=busy)
    assert published == [] and st['review'] == 3
    assert st['then'] == (('busy', 3), 'review')


def test_nothing_found_sends_no_sheet():
    st, _, said = run_job([])
    assert said == ['这个网址里没找到歌'] and st['review_id'] == ''


def test_check_url_reports_unsupported_or_disabled_sites():
    h = Harvester(http=None, send=None)
    assert h.check_url('https://archive.org/details/x', SETTINGS) == (None, '这个网站还不支持')
    a, why = h.check_url('https://music.163.com/#/song?id=1', {'sites': []})
    assert a is None and '关着' in why


def test_harvest_endpoints(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    monkeypatch.setattr(appmod, 'harvester', Harvester(http=None, send=None))
    c = TestClient(appmod.app)
    key = {'X-Key': 'k1'}
    assert c.post('/harvest', json={'url': 'https://music.163.com/#/song?id=1'}).status_code == 403
    assert c.get('/harvest/options', headers=key).json() == {'sites': [{'key': 'netease', 'name': '网易云音乐 music.163.com'}]}
    r = c.post('/harvest', json={'url': 'https://music.example.com/x', 'settings': SETTINGS}, headers=key)
    assert r.status_code == 400 and r.json()['detail'] == '这个网站还不支持'
    assert c.post('/harvest', json={'url': 'not a url'}, headers=key).status_code == 400
    assert c.get('/harvest/status', headers=key).json() == {'status': 'idle'}
    assert c.get('/harvest/review/abcdefghijklmn', headers=key).status_code == 404
    assert c.get('/harvest/review/abcdefghijklmn').status_code == 403
    r = c.post('/harvest/review', json={'id': 'abcdefghijklmn', 'ok': True}, headers=key)
    assert r.json() == {'result': 'missing', 'count': 0}


def test_bot_say_turns_buttons_into_inline_buttons(monkeypatch):
    sent = []

    class Bot:
        async def send_message(self, chat, text, **kw):
            sent.append((chat, text, kw))

    monkeypatch.setattr(appmod, 'bot_client', Bot())
    asyncio.run(appmod.bot_say('9', '审核单', buttons=[[('✅ 审核通过', 'hv:ok:abc'), ('❌ 审核失败', 'hv:no:abc')]]))
    asyncio.run(appmod.bot_say(9, '普通消息'))
    (chat, text, kw), (_, _, plain) = sent  # Telethon 各版本按钮的字段不一样：data 在按钮上或 type 上
    assert chat == 9 and [[(b.text, getattr(b, 'data', None) or b.type.data) for b in row] for row in kw['buttons']] == [
        [('✅ 审核通过', b'hv:ok:abc'), ('❌ 审核失败', b'hv:no:abc')]]
    assert plain['buttons'] is None
