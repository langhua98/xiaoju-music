"""访问网站：带上说明身份的 User-Agent（维基要求写明联系方式），被限流（429）或服务器出错时等一会儿再试。"""

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request

UA = 'XiaojuMusicHarvester/1.0 (https://xiaoju-music.langhua98.workers.dev; own-song importer)'


class Http:
    def __init__(self, gap=1.0, tries=4):
        self.gap, self.tries = gap, tries
        self.lock = asyncio.Lock()  # 一个一个来，请求之间隔 gap 秒

    def _open(self, url, timeout):
        headers = {'User-Agent': UA}
        host = (urllib.parse.urlparse(url).hostname or '').lower()
        if host == '163.com' or host.endswith('.163.com'):
            headers['Referer'] = 'https://music.163.com/'  # 网易云的接口要带
        return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)

    async def _fetch(self, url, read, timeout=60):
        wait = 5
        for attempt in range(self.tries):
            async with self.lock:
                try:
                    return await asyncio.to_thread(lambda: read(self._open(url, timeout)))
                except urllib.error.HTTPError as e:
                    if e.code not in (429, 500, 502, 503, 504) or attempt == self.tries - 1:
                        raise
                    retry = e.headers.get('Retry-After')
                    wait = int(retry) if retry and retry.isdigit() else wait * 2
                finally:
                    await asyncio.sleep(self.gap)
            await asyncio.sleep(min(wait, 120))

    async def final_url(self, url):
        """短链接跳到哪：跟着跳转走，返回最后的网址"""
        return await self._fetch(url, lambda r: r.geturl())

    async def get_json(self, url, params=None):
        if params:
            url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
        return await self._fetch(url, lambda r: json.loads(r.read().decode('utf-8')))

    async def get_bytes(self, url, max_bytes):
        def read(r):
            data = r.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise ValueError('too large')
            return data
        return await self._fetch(url, read, timeout=300)
