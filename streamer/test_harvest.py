"""授权音频搬运的测试：假的网站接口和发帖，不联网。"""

import asyncio

import pytest
from fastapi.testclient import TestClient

import app as appmod
from harvest import license as lic
from harvest.job import Harvester
from harvest.sites import Archive, Commons, find_adapter
from harvest.upload import UploadError, caption, publish

ALL_SETTINGS = {'sites': ['archive', 'commons'], 'licenses': lic.ALL, 'limit': 10}


# ── 授权检查 ──

@pytest.mark.parametrize('raw,code', [
    ('http://creativecommons.org/licenses/by-nc-sa/3.0/us/', 'by-nc-sa'),
    ('https://creativecommons.org/licenses/by/4.0/', 'by'),
    ('https://creativecommons.org/licenses/by-nd/2.0/', 'by-nd'),
    ('http://creativecommons.org/publicdomain/zero/1.0/', 'cc0'),
    ('https://creativecommons.org/publicdomain/mark/1.0/', 'pd'),
    ('CC BY-SA 4.0', 'by-sa'),
    ('CC-BY-NC-ND-3.0', 'by-nc-nd'),
    ('CC0', 'cc0'),
    ('Public domain', 'pd'),
    ('', None),
    ('All rights reserved', None),
    ('https://example.com/terms', None),
    ('Copyrighted free use', None),
])
def test_license_classify(raw, code):
    assert lic.classify(raw) == code


def test_license_check_copies_enabled_licenses_reviews_unknown_and_skips_reserved():
    assert lic.check('https://creativecommons.org/licenses/by/4.0/', ['by'])[:2] == ('ok', 'by')
    verdict, code, why = lic.check('https://creativecommons.org/licenses/by-nc/4.0/', ['by', 'cc0'])
    assert (verdict, code) == ('skip', 'by-nc') and '没勾选' in why
    for raw in ('All rights reserved', '© 2020 Some Label', 'http://rightsstatements.org/vocab/InC/1.0/', '版权所有'):
        verdict, code, why = lic.check(raw, lic.ALL)
        assert (verdict, code) == ('skip', None) and '版权保留' in why, raw
    assert lic.check('', lic.ALL) == ('review', None, '没有授权标记')
    verdict, _, why = lic.check('https://example.com/terms', lic.ALL)
    assert verdict == 'review' and why == '认不出授权（https://example.com/terms）'


# ── 网站适配器 ──

class FakeHttp:
    def __init__(self, pages, blobs=None):
        self.pages, self.blobs, self.asked = pages, blobs or {}, []

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


ITEM = {
    'metadata': {'identifier': 'tpdm087', 'mediatype': 'audio', 'creator': 'Andrew Cauthen',
                 'licenseurl': 'http://creativecommons.org/licenses/by-nc-sa/3.0/us/'},
    'files': [
        {'name': 'a.flac', 'format': 'Flac', 'source': 'original', 'title': 'Song A', 'artist': 'Take Pills Die', 'length': '3:35'},
        {'name': 'a.mp3', 'format': 'VBR MP3', 'source': 'derivative', 'original': 'a.flac', 'size': '5000'},
        {'name': 'b.mp3', 'format': 'VBR MP3', 'source': 'original', 'length': '120.5', 'size': '3000'},
        {'name': 'cover.jpg', 'format': 'JPEG', 'source': 'original'},
        {'name': 'tpdm087_meta.xml', 'format': 'Metadata', 'source': 'original'},
    ],
}


def test_archive_item_prefers_mp3_and_keeps_author_license_source():
    http = FakeHttp({'https://archive.org/metadata/tpdm087': ITEM})
    ts = collect(Archive(), 'https://archive.org/details/tpdm087', http)
    assert [(t.title, t.artist, t.ext, t.duration) for t in ts] == [('Song A', 'Take Pills Die', 'mp3', 215.0), ('b', 'Andrew Cauthen', 'mp3', 120.5)]
    assert ts[0].audio_url == 'https://archive.org/download/tpdm087/a.mp3'
    assert ts[0].license == 'http://creativecommons.org/licenses/by-nc-sa/3.0/us/'
    assert ts[0].page_url == 'https://archive.org/details/tpdm087'


def test_archive_collection_and_search_list_items():
    pages = {
        'https://archive.org/metadata/netlabels': {'metadata': {'identifier': 'netlabels', 'mediatype': 'collection'}},
        'https://archive.org/advancedsearch.php': {'response': {'docs': [{'identifier': 'tpdm087'}]}},
        'https://archive.org/metadata/tpdm087': ITEM,
    }
    http = FakeHttp(pages)
    assert len(collect(Archive(), 'https://archive.org/details/netlabels', http)) == 2
    assert any('collection%3A' in a or 'collection:"netlabels"' in a for a in http.asked)
    http = FakeHttp(pages)
    assert len(collect(Archive(), 'https://archive.org/search?query=piano', http, limit=1)) == 1


COMMONS_INFO = {'query': {'pages': {
    '1': {'title': 'File:Gymnopedie No. 1.ogg', 'imageinfo': [{
        'url': 'https://upload.wikimedia.org/x/Gymnopedie_No._1.ogg', 'mime': 'application/ogg', 'size': 4000,
        'descriptionurl': 'https://commons.wikimedia.org/wiki/File:Gymnopedie_No._1.ogg', 'duration': 196.2,
        'extmetadata': {'Artist': {'value': '<a href="x">Kevin MacLeod</a>'}, 'LicenseUrl': {'value': 'https://creativecommons.org/licenses/by/3.0'},
                        'ObjectName': {'value': 'Gymnopedie No. 1'}}}]},
    '2': {'title': 'File:Photo.jpg', 'imageinfo': [{'mime': 'image/jpeg'}]},
}}}


def test_commons_file_and_category():
    api = 'https://commons.wikimedia.org/w/api.php'
    http = FakeHttp({api + '?action=query&cmlimit': {'query': {'categorymembers': [{'title': 'File:Gymnopedie No. 1.ogg'}, {'title': 'File:Photo.jpg'}]}},
                     api + '?action=query&format=json&iiprop': COMMONS_INFO})
    ts = collect(Commons(), 'https://commons.wikimedia.org/wiki/Category:Erik_Satie', http)
    assert [(t.title, t.artist, t.ext, t.license) for t in ts] == [('Gymnopedie No. 1', 'Kevin MacLeod', 'ogg', 'https://creativecommons.org/licenses/by/3.0')]
    ts = collect(Commons(), 'https://commons.wikimedia.org/wiki/File:Gymnopedie_No._1.ogg', http)
    assert len(ts) == 1


def test_find_adapter():
    assert find_adapter('https://archive.org/details/x').key == 'archive'
    assert find_adapter('https://commons.wikimedia.org/wiki/File:x.ogg').key == 'commons'
    assert find_adapter('https://music.example.com/song/1') is None


# ── 上传 ──

def test_publish_converts_non_mp3_and_writes_attribution():
    from harvest.sites import Track
    t = Track('Gymnopedie No. 1', 'Kevin MacLeod', 'https://u/x.ogg', 'https://creativecommons.org/licenses/by/3.0', 'https://c/wiki/File:x', 0, 10, 'ogg')
    sent = {}

    async def send(data, name, title, artist, seconds, text):
        sent.update(data=data, name=name, title=title, artist=artist, seconds=seconds, text=text)
        return 77

    async def main():
        return await publish(t, 'CC BY 署名', http=FakeHttp({}, {'https://u/x.ogg': b'OGG'}), send=send,
                             convert=lambda d: b'MP3:' + d, measure=lambda d: 196.4)
    assert asyncio.run(main()) == 77
    assert sent['data'] == b'MP3:OGG' and sent['name'] == 'Kevin MacLeod - Gymnopedie No. 1.mp3' and sent['seconds'] == 196
    assert sent['text'].splitlines()[:3] == ['Gymnopedie No. 1 — Kevin MacLeod', '授权：CC BY 署名', '来源：https://c/wiki/File:x']


def test_reviewed_caption_does_not_claim_a_license():
    from harvest.sites import Track
    from harvest.upload import REVIEWED
    t = Track('Song', 'Band', 'u', '', 'https://archive.org/details/x')
    c = caption(t, REVIEWED)
    assert f'授权：{REVIEWED}' in c and '来源：https://archive.org/details/x' in c
    assert '以上述授权公开发布' not in c and '没有写明转载授权' in c
    assert '以上述授权公开发布' in caption(t, 'CC0（放弃版权）')


def test_publish_refuses_huge_or_unconvertible():
    from harvest.sites import Track
    big = Track('x', '', 'u', 'cc0', 'p', 0, 999 * 1024 * 1024, 'mp3')
    with pytest.raises(UploadError):
        asyncio.run(publish(big, 'x', http=FakeHttp({}), send=None))
    bad = Track('x', '', 'u', 'cc0', 'p', 0, 10, 'wav')
    with pytest.raises(UploadError):
        asyncio.run(publish(bad, 'x', http=FakeHttp({}, {'u': b'W'}), send=None, convert=lambda d: None))


# ── 串起来跑一次 ──

class Site:
    """假的网站：给定的音轨"""
    key, name = 'archive', '假网站'

    def __init__(self, tracks):
        self.tracks = tracks

    async def items(self, url, limit, http):
        for t in self.tracks[:limit]:
            yield t


def run_job(tracks, settings=ALL_SETTINGS, existing=(), fail=(), then=None):
    """then(h)：跑完以后接着做的事（比如按审核单的按钮），返回值放进 state['then']"""
    from harvest.sites import Track
    published, said = [], []

    async def fake_publish(t, label, *, http, send):
        if t.title in fail:
            raise UploadError('下载失败')
        published.append((t.title, label))
        return 100 + len(published)

    async def say(chat, text, buttons=None):
        said.append((text, buttons) if buttons else text)

    async def sleep(n):
        pass

    async def main():
        h = Harvester(http=None, send=None, say=say, sleep=sleep, publish_fn=fake_publish)
        h.check_url = lambda url, s: (Site([Track(*x) for x in tracks]), None)
        h.state = {}
        h.start('https://archive.org/details/x', settings, list(existing), notify=9, link='https://w.example/')
        await h.task
        if then is None:
            return h.state
        out = await then(h)
        return {**h.state, 'then': out}

    return asyncio.run(main()), published, said


def test_every_track_goes_through_the_license_check():
    tracks = [
        ('甲', 'A', 'u1', 'https://creativecommons.org/licenses/by/4.0/', 'p1'),
        ('乙', 'B', 'u2', 'All rights reserved', 'p2'),
        ('丙', 'C', 'u3', '', 'p3'),
        ('丁', 'D', 'u4', 'https://creativecommons.org/licenses/by-nc/4.0/', 'p4'),
        ('戊', 'E', 'u5', 'CC0', 'p5'),
        ('己', 'F', 'u6', 'CC0', 'p6'),
        ('庚', 'G', 'u7', '', 'p7'),  # 没标授权，但库里已经有了：不进审核单
    ]
    st, published, said = run_job(tracks, settings={'sites': ['archive'], 'licenses': ['by', 'cc0'], 'limit': 10},
                                  existing=[('戊', 'E'), ('庚', 'G')], fail=['己'])
    assert published == [('甲', 'CC BY 署名')]
    reasons = {r['title']: (r['status'], r.get('reason', '')) for r in st['results']}
    assert reasons['乙'][0] == 'skipped' and '版权保留' in reasons['乙'][1]
    assert reasons['丙'] == ('review', '没有授权标记')
    assert '没勾选' in reasons['丁'][1]
    assert reasons['戊'] == ('skipped', '小橘音乐里已经有了')
    assert reasons['己'] == ('failed', '下载失败')
    assert reasons['庚'] == ('skipped', '小橘音乐里已经有了')
    assert st['copied'] == 1 and st['new_ids'] == [101] and st['review'] == 1
    assert '从假网站搬了 1 首，跳过 4 首，1 首没标明授权、等你审核' in said[0] and '乙：写明了版权保留' in said[0]
    sheet, buttons = said[1]
    sid = st['review_id']
    assert f'🛂 审核单 {sid}' in sheet and '丙 — C：没有授权标记' in sheet and 'p3' in sheet
    assert f'查看全部：https://w.example/harvest-review/{sid}' in sheet
    assert buttons == [[('✅ 审核通过', f'hv:ok:{sid}'), ('❌ 审核失败', f'hv:no:{sid}')]]


def test_approving_a_sheet_publishes_its_tracks_with_a_reviewed_label():
    from harvest.upload import REVIEWED
    tracks = [('甲', 'A', 'u1', '', 'p1'), ('乙', 'B', 'u2', 'https://example.com/terms', 'p2'),
              ('丙', 'C', 'u3', '', 'p3'), ('甲', 'A', 'u1b', '', 'p1b')]  # 同一页里重复的只进一次

    async def approve(h):
        sid = h.state['review_id']
        info = h.sheet_info(sid)
        assert [t['title'] for t in info['tracks']] == ['甲', '乙', '丙'] and info['status'] == 'review'
        # 审核期间丙已经被别的方式搬进来了：通过时再查一次重
        assert h.decide(sid, True, [('丙', 'C')], notify=9) == ('approved', 3)
        await h.task
        assert h.decide(sid, True, [], notify=9) == ('done', 3)
        assert h.decide('nosuchsheet000', True, []) == ('missing', 0)
        return h.state

    st, published, said = run_job(tracks, then=approve)
    assert published == [('甲', REVIEWED), ('乙', REVIEWED)]
    assert st['then']['copied'] == 2 and st['then']['skipped'] == 1
    assert '从假网站搬了 2 首，跳过 1 首' in said[-1] and f'甲（{REVIEWED}）' in said[-1]


def test_rejecting_a_sheet_publishes_nothing():
    async def reject(h):
        sid = h.state['review_id']
        r = h.decide(sid, False, [])
        return r, h.sheet_info(sid)['status'], h.decide(sid, True, [])

    st, published, _ = run_job([('甲', 'A', 'u1', '', 'p1')], then=reject)
    assert published == [] and st['then'] == (('rejected', 1), 'rejected', ('done', 1))


def test_review_waits_while_another_harvest_runs_and_counts_toward_the_limit():
    tracks = [(f'歌{i}', 'A', 'u', '', 'p') for i in range(8)]

    async def busy(h):
        sid = h.state['review_id']
        h.task = asyncio.get_running_loop().create_future()  # 假装还在搬
        r = h.decide(sid, True, [])
        h.task.cancel()
        return r, h.sheet_info(sid)['status']

    st, published, _ = run_job(tracks, settings={'sites': ['archive'], 'licenses': ['cc0'], 'limit': 3}, then=busy)
    assert published == [] and st['review'] == 3
    assert st['then'] == (('busy', 3), 'review')


def test_limit_counts_only_copied_tracks():
    tracks = [(f'歌{i}', 'A', 'u', 'CC0', 'p') for i in range(8)]
    st, published, _ = run_job(tracks, settings={'sites': ['archive'], 'licenses': ['cc0'], 'limit': 3})
    assert len(published) == 3


def test_check_url_reports_unsupported_or_disabled_sites():
    h = Harvester(http=None, send=None)
    assert h.check_url('https://music.example.com/x', ALL_SETTINGS) == (None, '这个网站还不支持')
    a, why = h.check_url('https://archive.org/details/x', {'sites': ['commons']})
    assert a is None and '关着' in why


def test_harvest_endpoints(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    monkeypatch.setattr(appmod, 'harvester', Harvester(http=None, send=None))
    c = TestClient(appmod.app)
    key = {'X-Key': 'k1'}
    assert c.post('/harvest', json={'url': 'https://archive.org/details/x'}).status_code == 403
    r = c.get('/harvest/options', headers=key).json()
    assert [s['key'] for s in r['sites']] == ['archive', 'commons'] and len(r['licenses']) == 8
    r = c.post('/harvest', json={'url': 'https://music.example.com/x', 'settings': ALL_SETTINGS}, headers=key)
    assert r.status_code == 400 and r.json()['detail'] == '这个网站还不支持'
    assert c.post('/harvest', json={'url': 'not a url'}, headers=key).status_code == 400
    assert c.get('/harvest/status', headers=key).json() == {'status': 'idle'}
    assert c.get('/harvest/review/abcdefghijklmn', headers=key).status_code == 404
    assert c.get('/harvest/review/abcdefghijklmn').status_code == 403
    r = c.post('/harvest/review', json={'id': 'abcdefghijklmn', 'ok': True}, headers=key)
    assert r.json() == {'result': 'missing', 'count': 0}


def test_titles_drop_a_leading_author():
    from harvest.sites import _title
    assert _title('Kevin MacLeod - Erik Satie Gymnopedie No 1', 'Kevin MacLeod') == 'Erik Satie Gymnopedie No 1'
    assert _title('Gymnopedie', 'Kevin MacLeod') == 'Gymnopedie'
    assert _title('Kevin MacLeod', 'Kevin MacLeod') == 'Kevin MacLeod'


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
