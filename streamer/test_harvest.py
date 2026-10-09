"""贴网址搬自己的歌的测试：假的网易云接口和发帖，不联网。"""

import asyncio

import pytest
from fastapi.testclient import TestClient

import app as appmod
from harvest.job import Harvester
from harvest.sites import NetEase, Track, find_adapter
from harvest.upload import OWN, NoSource, UploadError, caption, publish

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


NE = 'http://127.0.0.1:3017'  # 本机的 api-enhanced


def ne_song(i, name, artists, ms=200000):
    return {'id': i, 'name': name, 'ar': [{'name': a} for a in artists], 'dt': ms}


def test_netease_song_album_playlist_artist_and_short_link():
    pages = {
        NE + '/song/detail?ids=11': {'code': 200, 'songs': [ne_song(11, '晴天', ['小橘', '朋友'])]},
        NE + '/album?id=5': {'code': 200, 'songs': [ne_song(21, '一', ['小橘']), ne_song(22, '二', ['小橘'])]},
        NE + '/playlist/track/all?id=7&limit=2&offset=0': {'code': 200, 'songs': [ne_song(31, '甲', ['A']), ne_song(32, '乙', ['B'])]},
        NE + '/artist/songs?id=9&limit=50&offset=0&order=time': {'code': 200, 'songs': [ne_song(41, '新歌', ['小橘'])], 'more': True},
        NE + '/artist/songs?id=9&limit=50&offset=1&order=time': {'code': 200, 'songs': [ne_song(42, '旧歌', ['小橘'])], 'more': False},
    }
    http = FakeHttp(pages, redirects={'https://163cn.tv/abc': 'https://y.music.163.com/m/song?id=11&uct2=x'})
    [t] = collect(NetEase(NE), 'https://music.163.com/#/song?id=11', http)
    assert (t.title, t.artist, t.duration, t.sid) == ('晴天', '小橘 / 朋友', 200.0, '11')
    assert t.page_url == 'https://music.163.com/song?id=11' and t.audio_url == '', '下载地址发帖时才取'
    assert [x.title for x in collect(NetEase(NE), 'https://163cn.tv/abc', http)] == ['晴天']
    assert [x.title for x in collect(NetEase(NE), 'https://music.163.com/album?id=5', http)] == ['一', '二']
    assert [x.title for x in collect(NetEase(NE), 'https://music.163.com/#/playlist?id=7', http, limit=2)] == ['甲', '乙']
    assert [x.title for x in collect(NetEase(NE), 'https://music.163.com/#/artist?id=9', http)] == ['新歌', '旧歌']
    assert collect(NetEase(NE), 'https://music.163.com/#/discover', http) == []
    http = FakeHttp({NE + '/album?id=6': {'code': -462}})
    with pytest.raises(RuntimeError, match='code -462'):
        collect(NetEase(NE), 'https://music.163.com/album?id=6', http)


def test_netease_user_homepage_is_the_musician_and_counting(monkeypatch):
    pages = {
        NE + '/user/detail?uid=77': {'code': 200, 'profile': {'nickname': '小橘', 'artistId': 9}},
        NE + '/user/detail?uid=78': {'code': 200, 'profile': {'nickname': '路人'}},
        NE + '/artist/detail?id=9': {'code': 200, 'data': {'artist': {'name': '小橘', 'musicSize': 3}}},
        NE + '/artist/songs?id=9&limit=50&offset=0&order=time': {'code': 200, 'more': False, 'songs': [
            ne_song(41, '新歌', ['小橘']), ne_song(42, '旧歌', ['小橘']), ne_song(43, '新歌', ['小橘'])]},
        NE + '/album?id=5': {'code': 200, 'album': {'name': '晴天'}, 'songs': [ne_song(21, '一', ['小橘'])]},
    }
    http = FakeHttp(pages)
    home = 'https://music.163.com/#/user/home?id=77'
    assert [t.title for t in collect(NetEase(NE), home, http)] == ['新歌', '旧歌', '新歌']
    assert asyncio.run(NetEase(NE).describe(home, http)) == ('artist', '小橘', '9'), '用户主页换成他的歌手编号'
    assert asyncio.run(NetEase(NE).describe('https://music.163.com/album?id=5', http)) == ('album', '晴天', '5')
    with pytest.raises(ValueError, match='不是音乐人'):
        collect(NetEase(NE), 'https://music.163.com/#/user/home?id=78', http)

    pages[NE + '/artist/top/song?id=9'] = {'code': 200, 'songs': [ne_song(51, '热门', ['小橘']), ne_song(52, '次热门', ['小橘'])]}

    async def hot(url):
        return [t.title async for t in NetEase(NE).hot(url, http)]

    async def hot_with(url, cookie):
        return [t.title async for t in NetEase(NE).hot(url, http, cookie)]
    assert asyncio.run(hot(home)) == ['热门', '次热门'], '主页的热门 50 首'
    assert asyncio.run(hot('https://music.163.com/album?id=5')) == [], '不是主页没有热门'

    # 登录过就带上 cookie：海外机房不登录去要，网易云常常给 0 首
    pages[NE + '/user/detail?cookie=MUSIC_U=x&uid=77'] = pages[NE + '/user/detail?uid=77']
    pages[NE + '/artist/top/song?cookie=MUSIC_U=x&id=9'] = pages[NE + '/artist/top/song?id=9']
    http.asked.clear()
    assert asyncio.run(hot_with(home, 'MUSIC_U=x')) == ['热门', '次热门']
    assert http.asked == [NE + '/user/detail?cookie=MUSIC_U=x&uid=77', NE + '/artist/top/song?cookie=MUSIC_U=x&id=9']

    monkeypatch.setattr('harvest.job.find_adapter', lambda url: NetEase(NE))
    h = Harvester(http=http, send=None)
    got = asyncio.run(h.count(home, SETTINGS, [('旧歌', '小橘')]))
    assert got == {'site': '网易云音乐 music.163.com', 'kind': 'artist', 'name': '小橘', 'total': 2, 'have': 1}, '重复的只算一次'
    with pytest.raises(ValueError, match='关着'):
        asyncio.run(h.count(home, {'sites': []}, []))


def test_netease_search_pages_until_limit_or_end():
    pages = {
        NE + '/cloudsearch?keywords=小橘&limit=3&offset=0&type=1': {'code': 200, 'result': {'songCount': 5, 'songs': [
            ne_song(1, '甲', ['小橘']), ne_song(2, '乙', ['小橘'])]}},
        NE + '/cloudsearch?keywords=小橘&limit=1&offset=2&type=1': {'code': 200, 'result': {'songCount': 5, 'songs': [ne_song(3, '丙', ['小橘'])]}},
        NE + '/cloudsearch?keywords=小橘&limit=100&offset=0&type=1': {'code': 200, 'result': {'songCount': 2, 'songs': [
            ne_song(1, '甲', ['小橘']), ne_song(2, '乙', ['小橘'])]}},
        NE + '/cloudsearch?keywords=none&limit=100&offset=0&type=1': {'code': 200, 'result': {'songCount': 0}},
    }

    def search(query, limit):
        http = FakeHttp(pages)

        async def main():
            return [t.title async for t in NetEase(NE).search(query, limit, http)]
        return asyncio.run(main()), http.asked

    assert search('小橘', 3)[0] == ['甲', '乙', '丙'], '一页不够翻下一页，够了就停'
    titles, asked = search('小橘', 150)
    assert titles == ['甲', '乙'] and len(asked) == 1, '搜完了就停'
    assert search('none', 150)[0] == []


def test_netease_download_needs_a_full_song_not_a_trial():
    t = Track('晴天', '小橘', '', 'p', 200, 0, 'mp3', sid='11')
    url = NE + '/song/url/v1?cookie=MUSIC_U=x&id=11&level=exhigh'

    def dl(page, cookie='MUSIC_U=x'):
        return asyncio.run(NetEase(NE).download(t, FakeHttp({url if cookie else NE + '/song/url/v1?id=11&level=exhigh': page}), cookie))

    got = dl({'code': 200, 'data': [{'id': 11, 'url': 'http://m701.music.126.net/a.mp3', 'size': 3158561, 'type': 'MP3', 'freeTrialInfo': None}]})
    assert (got.audio_url, got.size, got.ext, got.title) == ('http://m701.music.126.net/a.mp3', 3158561, 'mp3', '晴天')
    with pytest.raises(UploadError, match='试听片段（会员过期了'):
        dl({'code': 200, 'data': [{'id': 11, 'url': 'http://x/a.mp3', 'freeTrialInfo': {'start': 0, 'end': 30}}]})
    with pytest.raises(UploadError, match='先发「网易云登录」') as e:
        dl({'code': 200, 'data': [{'id': 11, 'url': None}]}, cookie='')
    assert not isinstance(e.value, NoSource), '没登录：不算灰色歌，登录了就能下'
    with pytest.raises(NoSource, match='下架了，或者要单独购买'):
        dl({'code': 200, 'data': [{'id': 11, 'url': None}]})


def test_netease_info_of_a_song_without_a_source():
    t = Track('天黑黑', '孙燕姿', '', 'https://music.163.com/song?id=11', 233.7, sid='11')
    detail = {'code': 200, 'songs': [{'id': 11, 'name': '天黑黑', 'fee': 1, 'pop': 100, 'dt': 233733, 'publishTime': 1179158400000,
                                      'al': {'name': 'My Story 2006 新歌+精选'}}], 'privileges': [{'id': 11, 'st': -200, 'fee': 1}]}
    http = FakeHttp({NE + '/song/detail?cookie=MUSIC_U=x&ids=11': detail})
    got = asyncio.run(NetEase(NE).info(t, http, 'MUSIC_U=x'))
    assert got == {'sid': '11', 'title': '天黑黑', 'artist': '孙燕姿', 'album': 'My Story 2006 新歌+精选', 'year': '2007',
                   'duration': 234, 'pop': 100, 'why': '网易云没版权', 'page': 'https://music.163.com/song?id=11'}
    detail['privileges'][0]['st'] = 0
    detail['songs'][0]['fee'] = 4
    assert asyncio.run(NetEase(NE).info(t, http, 'MUSIC_U=x'))['why'] == '要单独购买专辑'


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

    async def search(self, query, limit, http):
        self.query = query
        for t in self.tracks[:limit]:
            yield t


def run_job(tracks, settings=SETTINGS, existing=(), fail=(), then=None, query=''):
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
        h.check_url = h.check_query = lambda *a: (site, None)
        h.start('' if query else 'https://music.163.com/#/artist?id=9', settings, list(existing), notify=9,
                link='https://w.example/', query=query)
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


def test_approving_into_a_test_channel():
    sent = []

    async def send(*a, channel=''):
        sent.append(channel)
        return 1

    async def fake_publish(t, *, http, send):
        return await send(b'', 'f.mp3', t.title, t.artist, 1, 'c')

    said = []

    async def say(chat, text, buttons=None):
        said.append(text)

    async def main():
        h = Harvester(http=None, send=send, say=say, sleep=lambda n: asyncio.sleep(0), publish_fn=fake_publish)
        site = Site([Track('甲', 'A', 'u1', 'p1')])
        h.check_url = lambda *a: (site, None)
        h.start('https://music.163.com/#/song?id=1', SETTINGS, [], notify=9)
        await h.task
        assert h.decide(h.state['review_id'], True, [], notify=9, channel='xiaoju_test') == ('approved', 1)
        await h.task
    asyncio.run(main())
    assert sent == ['xiaoju_test']
    assert said[-1].startswith('📥 审核通过的发进测试频道 @xiaoju_test 1 首')
    h = Harvester(http=None, send=None)
    h.state = {**h._fresh('post', '', 'x'), 'total': 20, 'copied': 5, 'results': [{}] * 6}
    assert h.busy_text() == '正在把审核通过的 20 首发进频道（已发 5 首，处理到第 6 首）' 


def test_approval_fetches_download_urls_with_the_login_cookie():
    got, said = [], []

    class Dl(Site):
        async def download(self, t, http, cookie):
            if t.title == 'VIP':
                raise UploadError('网易云只给试听片段')
            return Track(t.title, t.artist, 'http://cdn/' + t.sid + '?' + cookie, t.page_url, sid=t.sid)

    async def fake_publish(t, *, http, send):
        got.append(t.audio_url)
        return 1

    async def say(chat, text, buttons=None):
        said.append(text)

    async def main():
        h = Harvester(http=None, send=None, say=say, sleep=lambda n: asyncio.sleep(0), publish_fn=fake_publish)
        site = Dl([Track('甲', 'A', '', 'p1', sid='1'), Track('VIP', 'A', '', 'p2', sid='2')])
        h.check_url = lambda *a: (site, None)
        h.start('https://music.163.com/#/album?id=1', SETTINGS, [], notify=9)
        await h.task
        h.decide(h.state['review_id'], True, [], notify=9, cookie='MUSIC_U=x')
        await h.task
    asyncio.run(main())
    assert got == ['http://cdn/1?MUSIC_U=x']
    assert 'VIP：网易云只给试听片段' in said[-1]


def test_netease_login_sends_the_qr_and_keeps_the_cookie_for_the_worker(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    checks = iter([{'code': 801}, {'code': 803, 'cookie': 'MUSIC_U=secret'}])

    class Http:
        def __init__(self, **kw):
            pass

        async def get_json(self, url, params=None):
            path = url.split('3017', 1)[1]
            if path == '/login/qr/key':
                return {'code': 200, 'data': {'unikey': 'k'}}
            if path == '/login/qr/create':
                assert params['key'] == 'k'
                return {'code': 200, 'data': {'qrimg': 'data:image/png;base64,UE5H'}}
            if path == '/login/qr/check':
                return next(checks)
            assert path == '/user/account' and params['cookie'] == 'MUSIC_U=secret'
            return {'code': 200, 'profile': {'nickname': '还是一样i1998'}}

    sent, said = [], []

    class Bot:
        async def send_file(self, chat, f, caption=''):
            sent.append((chat, f.read()))

        async def send_message(self, chat, text, **kw):
            said.append(text)

    monkeypatch.setattr(appmod, 'Http', Http)
    monkeypatch.setattr(appmod, 'bot_client', Bot())
    monkeypatch.setattr(appmod, 'netease_session', {})
    asyncio.run(appmod.netease_login(9, poll=0.001))
    assert sent == [(9, b'PNG')]
    assert said == ['✅ 网易云已登录：还是一样i1998。以后审核通过的 VIP 歌用这个账号下载']
    s = appmod.netease_session
    assert (s['cookie'], s['nickname']) == ('MUSIC_U=secret', '还是一样i1998') and s['at'] > 0
    c = TestClient(appmod.app)
    assert c.get('/netease/session').status_code == 403
    assert c.get('/netease/session', headers={'X-Key': 'k1'}).json()['cookie'] == 'MUSIC_U=secret' 


def test_alt_sync_posts_new_songs_without_a_sheet():
    sent, said = [], []

    class Alt(Site):
        def __init__(self, songs):
            self.songs = songs

        async def items(self, url, limit, http):
            for t in self.songs[url][:limit]:
                yield t

        async def download(self, t, http, cookie):
            if t.title == '下架':
                raise UploadError('网易云不给下载（下架了，或者要单独购买）')
            return Track(t.title, t.artist, 'http://cdn/' + t.sid + '?' + cookie, t.page_url, sid=t.sid)

    async def fake_publish(t, *, http, send):
        sent.append((t.title, t.audio_url, await send(b'', 'f.mp3', t.title, t.artist, 1, 'c')))
        return len(sent)

    async def send(*a, channel=''):
        return channel or 'official'

    async def say(chat, text, buttons=None):
        said.append((chat, text, buttons))

    site = Alt({'u1': [Track('甲', '小橘', '', 'p1', sid='1'), Track('旧歌', '小橘', '', 'p2', sid='2'), Track('甲', '小橘', '', 'p1', sid='1')],
                'u2': [Track('下架', '朋友', '', 'p3', sid='3'), Track('乙', '朋友', '', 'p4', sid='4')]})

    async def main():
        h = Harvester(http=None, send=send, say=say, sleep=lambda n: asyncio.sleep(0), publish_fn=fake_publish)
        h.check_url = lambda *a: (site, None)
        h.start_direct([{'url': 'u1', 'name': '小橘'}, {'url': 'u2', 'name': '朋友'}], SETTINGS, [('旧歌', '小橘')],
                       notify=9, cookie='MUSIC_U=x')
        busy = h.busy_text()
        with pytest.raises(RuntimeError):
            h.start_direct([{'url': 'u1', 'name': '小橘'}], SETTINGS, [])
        await h.task
        return h, busy

    h, busy = asyncio.run(main())
    assert busy.startswith('正在同步小号')
    assert sent == [('甲', 'http://cdn/1?MUSIC_U=x', 'official'), ('乙', 'http://cdn/4?MUSIC_U=x', 'official')], '不出审核单，库里有的、重复的不发'
    assert said[0][0] == 9 and said[0][2] is None
    text = said[0][1]
    assert text.startswith('👥 同步小号「小橘、朋友」：热门前 50 首里新歌 3 首，发进频道 2 首，没发 1 首（1 首库里已有）')
    assert '下架：网易云不给下载' in text and h.sheets == {}


def test_songs_without_a_source_are_remembered_as_grey(monkeypatch):
    said = []

    class Grey(Site):
        async def download(self, t, http, cookie):
            if t.title == '没版权':
                raise NoSource('网易云不给下载（下架了，或者要单独购买）')
            raise UploadError('网易云只给试听片段（会员过期了？续上再发「网易云登录」）')

        async def info(self, t, http, cookie):
            if t.sid == '2':
                raise RuntimeError('网易云抽风')
            return {'sid': t.sid, 'title': t.title, 'artist': t.artist, 'album': '专辑', 'year': '2006', 'duration': 200,
                    'pop': 90, 'why': '网易云没版权', 'page': t.page_url}

    async def say(chat, text, buttons=None):
        said.append(text)

    tracks = [Track('没版权', '甲', '', 'p1', 200, sid='1'), Track('没版权', '乙', '', 'p2', 100, sid='2'),
              Track('会员歌', '甲', '', 'p3', sid='3')]

    async def main():
        h = Harvester(http=None, send=None, say=say)
        h.check_url = lambda *a: (Grey(tracks), None)
        h.start_direct([{'url': 'u', 'name': '小橘'}], SETTINGS, [], notify=9, cookie='MUSIC_U=x')
        await h.task
        return h
    h = asyncio.run(main())
    grey = list(h.grey.values())
    assert [(g['sid'], g['title'], g['album'], g['why']) for g in grey] == [('1', '没版权', '专辑', '网易云没版权'),
                                                                       ('2', '没版权', '', '网易云不给下载（下架了，或者要单独购买）')]
    assert all(g['at'] > 0 for g in grey), '信息拿不到也照样记歌名、歌手'
    assert '⬜ 其中 2 首网易云上没有音源' in said[-1], '只给试听的是会员问题，不算灰色'
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    monkeypatch.setattr(appmod, 'harvester', h)
    c = TestClient(appmod.app)
    assert c.get('/harvest/grey').status_code == 403
    assert [g['sid'] for g in c.get('/harvest/grey', headers={'X-Key': 'k1'}).json()['songs']] == ['1', '2']


def test_alt_sync_with_nothing_new():
    said = []

    async def say(chat, text, buttons=None):
        said.append(text)

    async def main():
        h = Harvester(http=None, send=None, say=say)
        h.check_url = lambda *a: (Site([Track('旧歌', '小橘', '', 'p')]), None)
        h.start_direct([{'url': 'u', 'name': '小橘'}], SETTINGS, [('旧歌', '小橘')], notify=9)
        await h.task
    asyncio.run(main())
    assert said == ['👥 同步小号「小橘」：热门前 50 首都在小橘音乐里了（1 首）']


def test_alt_sync_says_so_when_the_homepage_gives_no_songs():
    said, got = [], []

    class Hot(Site):
        async def hot(self, url, http, cookie=''):
            got.append((url, cookie))
            for t in {'u2': [Track('旧歌', '小橘', '', 'p')]}.get(url, []):
                yield t

    async def say(chat, text, buttons=None):
        said.append(text)

    async def main(alts):
        h = Harvester(http=None, send=None, say=say)
        h.check_url = lambda *a: (Hot([]), None)
        h.start_direct(alts, SETTINGS, [('旧歌', '小橘')], notify=9, cookie='MUSIC_U=x')
        await h.task
    asyncio.run(main([{'url': 'u1', 'name': '小橘'}]))
    assert got == [('u1', 'MUSIC_U=x')], '拉热门歌带上登录 cookie'
    assert said[-1].startswith('👥 同步小号「小橘」：网易云没给热门歌（小橘 一首都没拿到）'), '0 首不能说成「都在库里了」'
    asyncio.run(main([{'url': 'u1', 'name': '小橘'}, {'url': 'u2', 'name': '朋友'}]))
    assert said[-1] == '👥 同步小号「小橘、朋友」：热门前 50 首都在小橘音乐里了（1 首）；小橘 没拿到热门歌'


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
    assert Harvester(http=None, send=None).busy_text().startswith('正在抓上一个网址')
    assert published == [] and st['review'] == 3
    assert st['then'] == (('busy', 3), 'review')


def test_nothing_found_sends_no_sheet():
    st, _, said = run_job([])
    assert said == ['这个网址里没找到歌'] and st['review_id'] == ''


def test_crawling_by_keyword_searches_the_site():
    async def sheet(h):
        return h.sheet_info(h.state['review_id'])

    st, published, said = run_job([('晴天', '小橘', 'u1', 'p1')], query='小橘 晴天', then=sheet)
    assert published == []
    assert said[0].startswith('📥 从假网站搜「小橘 晴天」抓到 1 首，等你审核')
    assert '\n搜：小橘 晴天\n' in said[1][0] and '网址：' not in said[1][0]
    assert st['then']['query'] == '小橘 晴天' and [t['title'] for t in st['then']['tracks']] == ['晴天']
    st, _, said = run_job([], query='没有的歌')
    assert said == ['在假网站没搜到「没有的歌」']


def test_check_query_needs_a_searchable_site_turned_on():
    h = Harvester(http=None, send=None)
    a, why = h.check_query(SETTINGS)
    assert a.key == 'netease' and why is None
    assert h.check_query({'sites': []}) == (None, '没有开着的能搜歌的网站')


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
    r = c.post('/harvest', json={'query': '小橘', 'settings': {'sites': []}}, headers=key)
    assert r.status_code == 400 and r.json()['detail'] == '没有开着的能搜歌的网站'
    assert c.get('/harvest/status', headers=key).json() == {'status': 'idle'}
    assert c.post('/harvest/count', json={'url': 'https://music.example.com/x', 'settings': SETTINGS}, headers=key).json()['detail'] == '这个网站还不支持'
    assert c.post('/harvest/count', json={'url': 'x'}).status_code == 403
    assert c.post('/harvest/describe', json={'url': 'https://music.example.com/x', 'settings': SETTINGS}, headers=key).json()['detail'] == '这个网站还不支持'
    assert c.post('/harvest/alts', json={'alts': []}, headers=key).status_code == 400
    r = c.post('/harvest/alts', json={'alts': [{'url': 'https://music.example.com/x', 'name': '甲'}], 'settings': SETTINGS}, headers=key)
    assert r.status_code == 400 and r.json()['detail'] == '甲：这个网站还不支持'
    assert c.get('/harvest/review/abcdefghijklmn', headers=key).status_code == 404
    assert c.get('/harvest/review/abcdefghijklmn').status_code == 403
    r = c.post('/harvest/review', json={'id': 'abcdefghijklmn', 'ok': True}, headers=key)
    assert r.json() == {'result': 'missing', 'count': 0, 'channel': '', 'busy': ''}
    r = c.post('/harvest/review', json={'id': 'abcdefghijklmn', 'ok': True, 'channel': '@xiaoju_test'}, headers=key)
    assert r.json()['channel'] == 'xiaoju_test'
    assert c.post('/harvest/review', json={'id': 'x', 'ok': True, 'channel': 'bad name!'}, headers=key).status_code == 400


def test_netease_check_reports_login_downloads_and_channel(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')

    class Http:
        def __init__(self, **kw):
            pass

        async def get_json(self, url, params=None):
            path = url.split('3017', 1)[1]
            if path == '/user/account':
                return {'code': 200, 'profile': {'nickname': '小橘'}, 'account': {'vipType': 0}}
            if path == '/artist/top/song':
                return {'code': 200, 'songs': [ne_song(1, '甲', ['小橘']), ne_song(2, '乙', ['小橘'])]}
            if path == '/song/url/v1':
                if params['id'] == '1':
                    return {'code': 200, 'data': [{'id': 1, 'url': 'http://cdn/1.mp3', 'size': 9, 'type': 'mp3'}]}
                return {'code': 200, 'data': [{'id': 2, 'url': 'http://cdn/2.mp3', 'freeTrialInfo': {'end': 30}}]}
            raise AssertionError(path)

    monkeypatch.setattr(appmod, 'Http', Http)
    monkeypatch.setattr(appmod, 'user_client', None)
    c = TestClient(appmod.app)
    assert c.post('/netease/check', json={}).status_code == 403
    r = c.post('/netease/check', json={'cookie': 'MUSIC_U=x', 'alts': ['https://music.163.com/artist?id=9']}, headers={'X-Key': 'k1'}).json()
    assert (r['login'], r['nickname'], r['vip']) == (True, '小橘', 0)
    assert [x['ok'] for x in r['songs']] == [True, False] and '试听片段' in r['songs'][1]['why']
    assert r['channel'] == {'ok': False, 'why': '频道主账号没登录'}


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
