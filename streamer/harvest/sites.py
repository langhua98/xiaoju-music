"""网站适配器：每个网站一个类，只负责「这个网址里有哪些音频、每首的作者、授权、下载地址」。

不判断能不能搬（那是 license.py 的事），也不下载上传（那是 upload.py 的事）。
加新网站：写一个有 key、name、match(url)、items(url, limit, http) 的类，放进 ADAPTERS。"""

import html
import re
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlparse


@dataclass
class Track:
    title: str
    artist: str
    audio_url: str
    license: str          # 网站原样给的授权（网址或简称），交给 license.check 判断
    page_url: str         # 原始页面，写进帖子里
    duration: float = 0   # 秒，不知道就是 0
    size: int = 0         # 字节，不知道就是 0
    ext: str = ''         # 文件扩展名（mp3 / ogg / flac ...）


def _ext(name):
    m = re.search(r'\.([a-z0-9]{1,5})$', name or '', re.I)
    return m.group(1).lower() if m else ''


def _stem(name):
    return re.sub(r'\.[a-z0-9]{1,5}$', '', unquote(name or ''), flags=re.I).replace('_', ' ').strip()


def _seconds(v):
    """'215.3'、'3:35'、'1:02:03' → 秒"""
    if v in (None, ''):
        return 0.0
    s = str(v).strip()
    try:
        if ':' in s:
            total = 0.0
            for part in s.split(':'):
                total = total * 60 + float(part)
            return total
        return float(s)
    except ValueError:
        return 0.0


def _title(title, artist):
    """「作者 - 歌名」开头的作者去掉（文件名常这样起），歌名里只留歌名"""
    if artist and title.lower().startswith(artist.lower()):
        rest = title[len(artist):].lstrip(' -–—_:：')
        if rest:
            return rest
    return title


def _text(v):
    if isinstance(v, list):
        v = ', '.join(str(x) for x in v if x)
    return html.unescape(re.sub(r'<[^>]+>', '', str(v or ''))).strip()


# ── 互联网档案馆 archive.org ──────────────────────────────────────

class Archive:
    key, name = 'archive', '互联网档案馆 archive.org'
    AUDIO = ('VBR MP3', 'MP3', '128Kbps MP3', '64Kbps MP3', 'Ogg Vorbis', 'Flac', '24bit Flac', 'WAVE', 'Apple Lossless Audio')

    def match(self, url):
        host = (urlparse(url).hostname or '').lower()
        return host == 'archive.org' or host.endswith('.archive.org')

    async def items(self, url, limit, http):
        """支持 /details/条目、/details/合集、/search?query=关键词。按条目顺序给出音轨，最多看 limit 首。"""
        p = urlparse(url)
        m = re.match(r'^/details/([^/?#]+)', p.path)
        if p.path.startswith('/search'):
            q = dict(x.split('=', 1) for x in p.query.split('&') if '=' in x).get('query', '')
            ids = await self._search(f'({unquote(q).replace("+", " ")}) AND mediatype:audio', limit, http)
        elif m:
            ident = unquote(m.group(1))
            meta = await http.get_json(f'https://archive.org/metadata/{quote(ident)}')
            if (meta.get('metadata') or {}).get('mediatype') == 'collection':
                ids = await self._search(f'collection:"{ident}" AND mediatype:audio', limit, http)
            else:
                for t in self._tracks(meta)[:limit]:
                    yield t
                return
        else:
            return
        n = 0
        for ident in ids:
            meta = await http.get_json(f'https://archive.org/metadata/{quote(ident)}')
            for t in self._tracks(meta):
                if n >= limit:
                    return
                n += 1
                yield t

    async def _search(self, q, limit, http):
        # 只列出标了授权的条目（没标的反正过不了授权检查），免得翻一大堆都被跳过
        d = await http.get_json('https://archive.org/advancedsearch.php',
                                {'q': f'({q}) AND licenseurl:*', 'fl[]': 'identifier', 'rows': str(max(5, min(limit, 200))), 'output': 'json',
                                 'sort[]': 'downloads desc'})
        return [x['identifier'] for x in ((d.get('response') or {}).get('docs') or []) if x.get('identifier')]

    def _tracks(self, meta):
        md = meta.get('metadata') or {}
        ident = md.get('identifier') or ''
        lic = md.get('licenseurl') or md.get('rights') or ''
        page = f'https://archive.org/details/{ident}'
        files = meta.get('files') or []
        derived = {}
        for f in files:  # 原始文件转出来的 mp3：优先给 mp3，手机都能放
            if f.get('source') == 'derivative' and 'MP3' in (f.get('format') or '') and f.get('original'):
                derived.setdefault(f['original'], f)
        out = []
        for f in files:
            if f.get('source') != 'original' or f.get('format') not in self.AUDIO:
                continue
            use = derived.get(f['name'], f)
            artist = _text(f.get('artist') or f.get('creator') or md.get('creator'))
            out.append(Track(
                title=_title(_text(f.get('title')) or _stem(f['name']), artist),
                artist=artist,
                audio_url=f'https://archive.org/download/{quote(ident)}/{quote(use["name"])}',
                license=lic, page_url=page,
                duration=_seconds(f.get('length') or use.get('length')),
                size=int(use.get('size') or 0), ext=_ext(use['name']),
            ))
        return out


# ── 维基共享资源 commons.wikimedia.org ─────────────────────────────

class Commons:
    key, name = 'commons', '维基共享资源 commons.wikimedia.org'
    API = 'https://commons.wikimedia.org/w/api.php'

    def match(self, url):
        return (urlparse(url).hostname or '').lower() in ('commons.wikimedia.org', 'commons.m.wikimedia.org')

    async def items(self, url, limit, http):
        """支持 /wiki/File:文件 和 /wiki/Category:分类（只取分类里直接放的文件）。"""
        m = re.search(r'/wiki/((?:File|Category):[^?#]+)', url)
        if not m:
            return
        page = unquote(m.group(1)).replace('_', ' ')
        if page.startswith('File:'):
            titles = [page]
        else:
            d = await http.get_json(self.API, {'action': 'query', 'list': 'categorymembers', 'cmtitle': page,
                                               'cmtype': 'file', 'cmlimit': str(min(500, max(10, limit * 3))), 'format': 'json'})
            titles = [x['title'] for x in ((d.get('query') or {}).get('categorymembers') or [])]
        n = 0
        for i in range(0, len(titles), 20):  # 一次问 20 个，别给维基太大压力
            d = await http.get_json(self.API, {'action': 'query', 'titles': '|'.join(titles[i:i + 20]), 'prop': 'imageinfo',
                                               'iiprop': 'url|mime|size|extmetadata|mediatype', 'format': 'json'})
            for pg in ((d.get('query') or {}).get('pages') or {}).values():
                info = (pg.get('imageinfo') or [{}])[0]
                if not (info.get('mime') or '').startswith(('audio/', 'application/ogg')) and info.get('mediatype') != 'AUDIO':
                    continue
                em = info.get('extmetadata') or {}
                val = lambda k: (em.get(k) or {}).get('value') or ''
                if n >= limit:
                    return
                n += 1
                name = pg['title'][len('File:'):]
                artist = _text(val('Artist'))
                yield Track(
                    title=_title(_text(val('ObjectName')) or _stem(name), artist),
                    artist=artist,
                    audio_url=info.get('url') or '',
                    license=val('LicenseUrl') or val('LicenseShortName') or val('License'),
                    page_url=info.get('descriptionurl') or f'https://commons.wikimedia.org/wiki/{quote(pg["title"].replace(" ", "_"))}',
                    duration=_seconds(info.get('duration')), size=int(info.get('size') or 0), ext=_ext(name),
                )


ADAPTERS = [Archive(), Commons()]


def find_adapter(url):
    """这个网址归哪个适配器管；还不支持的网站返回 None。开没开由调用的地方按设置判断。"""
    for a in ADAPTERS:
        if a.match(url):
            return a
    return None
