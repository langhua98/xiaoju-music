"""网站适配器：每个网站一个类，只负责「这个网址里有哪些音频、每首的作者、下载地址」。

不判断是不是我们的歌（那是频道主在审核单里做的），也不下载上传（那是 upload.py 的事）。
加新网站：写一个有 key、name、match(url)、items(url, limit, http) 的类，放进 ADAPTERS；
能按关键词搜的再写 search(query, limit, http)，「爬 关键词」就会用它；
下载地址要发帖时现取（会过期、要登录）的再写 download(track, http, cookie)。"""

import html
import os
import re
from dataclasses import dataclass, replace
from urllib.parse import urlparse


@dataclass
class Track:
    title: str
    artist: str
    audio_url: str
    page_url: str         # 原始页面，写进帖子里
    duration: float = 0   # 秒，不知道就是 0
    size: int = 0         # 字节，不知道就是 0
    ext: str = ''         # 文件扩展名（mp3 / ogg / flac ...）
    sid: str = ''         # 网站上的编号（适配器有 download() 时，发帖前用它现取下载地址）


def _text(v):
    if isinstance(v, list):
        v = ', '.join(str(x) for x in v if x)
    return html.unescape(re.sub(r'<[^>]+>', '', str(v or ''))).strip()


class NetEase:
    """小橘音乐自己的歌发在网易云上（大多是 VIP 歌）。网易云的接口都经 api-enhanced
    （NeteaseCloudMusicApiEnhanced，流式服务在本机拉起的 Node 服务，见 app.py 的 netease_api）调用：
    加密、接口改版它管。VIP 歌要带频道主登录过的网易云账号（cookie）才拿得到下载地址。"""
    key, name = 'netease', '网易云音乐 music.163.com'
    HOSTS = ('163cn.tv', 'music.163.com')
    LEVEL = 'exhigh'  # 320k mp3；无损是 flac，反正要转 mp3

    def __init__(self, api=None):
        self.api = (api or os.environ.get('NETEASE_API') or 'http://127.0.0.1:3017').rstrip('/')

    def match(self, url):
        host = (urlparse(url).hostname or '').lower()
        return any(host == h or host.endswith('.' + h) for h in self.HOSTS)

    async def _get(self, http, path, **params):
        d = await http.get_json(self.api + path, params)
        if not isinstance(d, dict) or d.get('code', 200) != 200:
            raise RuntimeError(f'网易云接口 {path} 出错（code {d.get("code") if isinstance(d, dict) else "?"}）')
        return d

    async def _parse(self, url, http):
        """网址 → (类型, 编号)：song / playlist / album / artist；用户主页（音乐人）换成他的歌手编号。认不出 → (None, None)"""
        if (urlparse(url).hostname or '').lower().endswith('163cn.tv'):
            url = await http.final_url(url)
        m = re.search(r'/(song|playlist|album|artist|user)\b[^#]*?[?&]id=(\d+)', url)
        if not m:
            return None, None
        kind, sid = m.group(1), m.group(2)
        if kind == 'user':
            aid = ((await self._get(http, '/user/detail', uid=sid)).get('profile') or {}).get('artistId')
            if not aid:
                raise ValueError('这个网易云用户不是音乐人，主页上没有自己的歌')
            kind, sid = 'artist', str(aid)
        return kind, sid

    async def describe(self, url, http):
        """先看这是什么：→ (类型, 名字, 编号)。类型：song 单曲 / album 专辑 / playlist 歌单 / artist 歌手主页（用户主页换成歌手）"""
        kind, sid = await self._parse(url, http)
        name = ''
        if kind == 'artist':
            name = (((await self._get(http, '/artist/detail', id=sid)).get('data') or {}).get('artist') or {}).get('name') or ''
        elif kind == 'album':
            name = ((await self._get(http, '/album', id=sid)).get('album') or {}).get('name') or ''
        elif kind == 'playlist':
            name = ((await self._get(http, '/playlist/detail', id=sid)).get('playlist') or {}).get('name') or ''
        return kind, _text(name), sid

    async def items(self, url, limit, http):
        """支持单曲、歌单、专辑、歌手主页、用户主页（song / playlist / album / artist / user/home?id=…，
        网页版带 #/ 的也行），和 App 分享的 163cn.tv 短链接。"""
        kind, sid = await self._parse(url, http)
        if not kind:
            return
        if kind == 'song':
            songs = (await self._get(http, '/song/detail', ids=sid)).get('songs') or []
        elif kind == 'album':
            songs = (await self._get(http, '/album', id=sid)).get('songs') or []
        elif kind == 'playlist':
            songs = (await self._get(http, '/playlist/track/all', id=sid, limit=str(limit), offset='0')).get('songs') or []
        else:  # 歌手：按发布时间从新到旧
            songs, offset = [], 0
            while len(songs) < limit:
                d = await self._get(http, '/artist/songs', id=sid, order='time', limit='50', offset=str(offset))
                page = d.get('songs') or []
                songs += page
                offset += len(page)
                if not page or not d.get('more', offset < int(d.get('total') or 0)):
                    break
        for s in songs[:limit]:
            yield self._track(s)

    async def hot(self, url, http):
        """主页（歌手主页、音乐人的用户主页）的热门歌：网易云的「热门 50 首」。不是主页 → 什么也没有"""
        kind, sid = await self._parse(url, http)
        if kind != 'artist':
            return
        for s in (await self._get(http, '/artist/top/song', id=sid)).get('songs') or []:
            yield self._track(s)

    async def search(self, query, limit, http):
        """按关键词（歌名、歌手）搜单曲，网易云排好的顺序。"""
        offset = 0
        while offset < limit:
            r = (await self._get(http, '/cloudsearch', keywords=query, type='1',
                                 limit=str(min(limit - offset, 100)), offset=str(offset))).get('result') or {}
            page = r.get('songs') or []
            for s in page:
                yield self._track(s)
            offset += len(page)
            if not page or offset >= int(r.get('songCount') or 0):
                break

    async def download(self, track, http, cookie=''):
        """审核通过、要发帖时才取下载地址（地址几十分钟就过期）。→ 填好 audio_url、size、ext 的 Track。
        拿不到、或只给试听片段（没登录、会员过期）时抛 UploadError。"""
        from .upload import UploadError
        params = {'id': track.sid, 'level': self.LEVEL}
        if cookie:
            params['cookie'] = cookie
        x = ((await self._get(http, '/song/url/v1', **params)).get('data') or [{}])[0]
        if not x.get('url'):
            raise UploadError('网易云不给下载' + ('（下架了，或者要单独购买）' if cookie else '（VIP 歌：先发「网易云登录」扫码登录）'))
        if x.get('freeTrialInfo'):
            raise UploadError('网易云只给试听片段' + ('（会员过期了？续上再发「网易云登录」）' if cookie else '（VIP 歌：先发「网易云登录」扫码登录）'))
        return replace(track, audio_url=x['url'], size=int(x.get('size') or 0), ext=(x.get('type') or 'mp3').lower())

    def _track(self, s):
        sid = s['id']
        artist = ' / '.join(a.get('name') or '' for a in (s.get('ar') or s.get('artists') or []) if a.get('name'))
        return Track(
            title=_text(s.get('name')) or str(sid), artist=artist, audio_url='',
            page_url=f'https://music.163.com/song?id={sid}',
            duration=(s.get('dt') or s.get('duration') or 0) / 1000, ext='mp3', sid=str(sid),
        )



ADAPTERS = [NetEase()]


def find_adapter(url):
    """这个网址归哪个适配器管；还不支持的网站返回 None。开没开由调用的地方按设置判断。"""
    for a in ADAPTERS:
        if a.match(url):
            return a
    return None


def search_adapters():
    """能按关键词搜的网站"""
    return [a for a in ADAPTERS if hasattr(a, 'search')]
