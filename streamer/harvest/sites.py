"""网站适配器：每个网站一个类，只负责「这个网址里有哪些音频、每首的作者、下载地址」。

不判断是不是我们的歌（那是频道主在审核单里做的），也不下载上传（那是 upload.py 的事）。
加新网站：写一个有 key、name、match(url)、items(url, limit, http) 的类，放进 ADAPTERS；
能按关键词搜的再写 search(query, limit, http)，「爬 关键词」就会用它。"""

import html
import json
import re
from dataclasses import dataclass
from urllib.parse import urlencode, urlparse


@dataclass
class Track:
    title: str
    artist: str
    audio_url: str
    page_url: str         # 原始页面，写进帖子里
    duration: float = 0   # 秒，不知道就是 0
    size: int = 0         # 字节，不知道就是 0
    ext: str = ''         # 文件扩展名（mp3 / ogg / flac ...）
    blocked: str = ''     # 网站已经说了不给下载：原因（不进审核单）；空＝可以试


def _text(v):
    if isinstance(v, list):
        v = ', '.join(str(x) for x in v if x)
    return html.unescape(re.sub(r'<[^>]+>', '', str(v or ''))).strip()


class NetEase:
    """小橘音乐自己的歌发在网易云上。VIP、下架的歌下载地址会跳到 404 网页，上传时报「网站不给下载」。"""
    key, name = 'netease', '网易云音乐 music.163.com'
    API = 'https://music.163.com/api'
    HOSTS = ('163cn.tv', 'music.163.com')

    def match(self, url):
        host = (urlparse(url).hostname or '').lower()
        return any(host == h or host.endswith('.' + h) for h in self.HOSTS)

    async def items(self, url, limit, http):
        """支持单曲、歌单、专辑、歌手（song / playlist / album / artist?id=…，网页版带 #/ 的也行），
        和 App 分享的 163cn.tv 短链接。"""
        if (urlparse(url).hostname or '').lower().endswith('163cn.tv'):
            url = await http.final_url(url)
        m = re.search(r'/(song|playlist|album|artist)\b[^#]*?[?&]id=(\d+)', url)
        if not m:
            return
        kind, sid = m.group(1), m.group(2)
        if kind == 'song':
            songs = await self._details([sid], http)
        elif kind == 'album':
            d = await http.get_json(f'{self.API}/v1/album/{sid}')  # 旧的 /api/album/<id> 现在回 -462（要验证）
            songs = d.get('songs') or []
        elif kind == 'playlist':
            d = await http.get_json(f'{self.API}/v6/playlist/detail', {'id': sid})
            ids = [str(x['id']) for x in ((d.get('playlist') or {}).get('trackIds') or [])][:limit]
            songs = []
            for i in range(0, len(ids), 50):
                songs += await self._details(ids[i:i + 50], http)
        else:  # 歌手：按发布时间从新到旧
            songs, offset = [], 0
            while len(songs) < limit:
                d = await http.get_json(f'{self.API}/v1/artist/songs', {'id': sid, 'limit': '50', 'offset': str(offset), 'order': 'time'})
                page = d.get('songs') or []
                songs += page
                offset += len(page)
                if not page or not d.get('more', offset < int(d.get('total') or 0)):
                    break
        for s in songs[:limit]:
            yield self._track(s)

    async def search(self, query, limit, http):
        """按关键词（歌名、歌手）搜单曲，网易云排好的顺序。"""
        offset = 0
        while offset < limit:
            # 不用 /search/get/web：海外请求它只回一串加密的字符串
            d = await http.get_json(f'{self.API}/search/get', {
                's': query, 'type': '1', 'limit': str(min(limit - offset, 100)), 'offset': str(offset)})
            r = d.get('result') or {}
            if not isinstance(r, dict):
                raise RuntimeError(f'网易云搜索返回的格式变了（code {d.get("code")}）')
            page = r.get('songs') or []
            for s in page:
                yield self._track(s)
            offset += len(page)
            if not page or offset >= int(r.get('songCount') or 0):
                break

    async def _details(self, ids, http):
        d = await http.get_json(f'{self.API}/song/detail/?' + urlencode({'ids': json.dumps([int(i) for i in ids])}))
        return d.get('songs') or []

    def _track(self, s):
        sid = s['id']
        artist = ' / '.join(a.get('name') or '' for a in (s.get('artists') or s.get('ar') or []) if a.get('name'))
        return Track(
            title=_text(s.get('name')) or str(sid), artist=artist,
            audio_url=f'https://music.163.com/song/media/outer/url?id={sid}.mp3',
            page_url=f'https://music.163.com/song?id={sid}',
            duration=(s.get('duration') or s.get('dt') or 0) / 1000, ext='mp3',
            # fee：0 免费；1 VIP；4 要买专辑；8 免费但高音质要 VIP。不是 0 的外链下载地址都跳到 404
            blocked='' if s.get('fee') in (None, 0) else '网易云不给下载（VIP 或付费的歌）',
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
