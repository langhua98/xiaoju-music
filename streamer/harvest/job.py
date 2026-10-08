"""把适配器、上传串起来：贴一个网址（或「爬 关键词」去网站上搜）→ 抓出里面的歌 → 凑成审核单发给频道主 → 频道主确认是我们的歌点「通过」→ 发进频道。

抓取只是把歌放进审核单，不会直接发：和小橘视频的审核单一样，整批「通过 / 失败」，失败的一首都不发。
审核单只存在内存里，服务重启就没了，重新发一次网址就行。

一次只跑一个（抓取或发帖）；结果（每首怎样了、为什么）记在 state 里，跑完通知频道主。"""

import asyncio
import logging
import re
import secrets
import string

from .sites import find_adapter, search_adapters
from .upload import UploadError, publish

log = logging.getLogger('streamer.harvest')


def norm(s):
    return re.sub(r'[\W_]+', '', (s or '').lower())


def song_key(t):
    return norm(t.title) + '|' + norm(t.artist)


KEEP_SHEETS = 20  # 内存里最多留几张审核单（旧的丢掉）


def sheet_id():
    """审核单编号：14 位小写字母和数字（知道编号才打得开「查看全部」）"""
    return ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(14))


class Harvester:
    def __init__(self, *, http, send, say=None, sleep=asyncio.sleep, pause=3.0, publish_fn=publish):
        self.http, self.send, self.say, self.sleep, self.pause = http, send, say, sleep, pause
        self.publish = publish_fn
        self.task = None
        self.state = {'status': 'idle'}
        self.sheets = {}  # 审核单编号 → {id, site, url, tracks, status}

    def running(self):
        return self.task is not None and not self.task.done()

    def check_url(self, url, settings):
        """开始前先看网址能不能抓：→ (适配器, None) 或 (None, 原因)。"""
        a = find_adapter(url)
        if a is None:
            return None, '这个网站还不支持'
        if a.key not in set(settings.get('sites') or ()):
            return None, f'「{a.name}」在搬运设置里关着'
        return a, None

    def check_query(self, settings):
        """按关键词搜用哪个网站：→ (适配器, None) 或 (None, 原因)。"""
        on = set(settings.get('sites') or ())
        for a in search_adapters():
            if a.key in on:
                return a, None
        return None, '没有开着的能搜歌的网站'

    def _fresh(self, kind, url, site):
        return {'status': 'running', 'kind': kind, 'url': url, 'site': site, 'copied': 0, 'skipped': 0,
                'review': 0, 'review_id': '', 'results': [], 'new_ids': [], 'error': ''}

    async def _notify(self, notify, *messages):
        if not (notify and self.say):
            return
        try:
            for text, buttons in messages:
                await self.say(notify, text, buttons=buttons) if buttons else await self.say(notify, text)
        except Exception:  # noqa: BLE001
            log.exception('notify failed')

    # ── 数歌：抓之前先看这个网址里一共几首、库里已有几首 ──

    async def count(self, url, settings, existing, http=None, most=1000):
        """→ {site, kind, name, total, have}。kind：song / album / playlist / artist（见适配器的 describe）。
        最多数 most 首。网址不支持或网站关着抛 ValueError"""
        adapter, why = self.check_url(url, settings)
        if adapter is None:
            raise ValueError(why)
        http = http or self.http
        kind, name = await adapter.describe(url, http) if hasattr(adapter, 'describe') else ('', '')
        seen = {norm(t) + '|' + norm(a) for t, a in existing}
        keys = set()
        async for t in adapter.items(url, most, http):
            keys.add(song_key(t))  # 同一首重复出现只算一次
        return {'site': adapter.name, 'kind': kind, 'name': name, 'total': len(keys), 'have': len(keys & seen)}

    # ── 抓取：网址里的歌 → 审核单 ──

    def start(self, url, settings, existing, notify=None, link='', query=''):
        """抓网址 url 里的歌；给了 query 就不看网址，去网站上按关键词搜。
        settings：{sites: [开着的网站], limit: 最多抓几首}。existing：库里已有的 [(歌名, 作者)]，有了的不进审核单。
        link：Worker 的网址，审核单里「查看全部」用"""
        if self.running():
            raise RuntimeError('already running')
        adapter, why = self.check_query(settings) if query else self.check_url(url, settings)
        if adapter is None:
            raise ValueError(why)
        self.state = self._fresh('crawl', url, adapter.name)
        self.state['query'] = query
        seen = {norm(t) + '|' + norm(a) for t, a in existing}
        self.task = asyncio.create_task(self._crawl(adapter, url, query, settings, seen, notify, link))

    async def _crawl(self, adapter, url, query, settings, seen, notify, link):
        st = self.state
        limit = max(1, min(int(settings.get('limit') or 20), 200))
        pending = []
        try:
            # 多看一些：库里已有的会跳过
            queued = set()
            found = adapter.search(query, limit * 3, self.http) if query else adapter.items(url, limit * 3, self.http)
            async for t in found:
                if len(pending) >= limit:
                    break
                if song_key(t) in queued:  # 同一页里重复的不进审核单两次
                    continue
                row = {'title': t.title, 'artist': t.artist, 'page': t.page_url}
                st['results'].append(row)
                if song_key(t) in seen:
                    row['status'], row['reason'] = 'skipped', '小橘音乐里已经有了'
                    st['skipped'] += 1
                    continue
                queued.add(song_key(t))
                row['status'] = 'review'
                pending.append(t)
            st['status'] = 'done'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('crawl failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
        sheet = self._add_sheet(adapter, url, pending, query) if pending else None
        if sheet:
            st['review'], st['review_id'] = len(pending), sheet['id']
        msgs = [(self.report(), None)]
        if sheet:
            msgs.append((self.sheet_text(sheet, link), [[
                ('✅ 审核通过', f'hv:ok:{sheet["id"]}'), ('❌ 审核失败', f'hv:no:{sheet["id"]}')]]))
        await self._notify(notify, *msgs)

    # ── 审核单 ──

    def _add_sheet(self, adapter, url, tracks, query=''):
        sheet = {'id': sheet_id(), 'site': adapter.name, 'adapter': adapter, 'url': url, 'query': query,
                 'status': 'review', 'tracks': tracks}
        self.sheets[sheet['id']] = sheet
        for old in list(self.sheets)[:-KEEP_SHEETS]:
            del self.sheets[old]
        return sheet

    def sheet_text(self, sheet, link=''):
        n = len(sheet['tracks'])
        lines = [f'🛂 审核单 {sheet["id"]}（{sheet["site"]}，{n} 首，确认是不是我们的歌）', f'搜：{sheet["query"]}' if sheet.get('query') else f'网址：{sheet["url"]}', '']
        for t in sheet['tracks'][:8]:
            lines.append(f'· {t.title}' + (f' — {t.artist}' if t.artist else '') + f'\n  {t.page_url}')
        if n > 8:
            lines.append(f'……还有 {n - 8} 首')
        if link:
            lines.append(f'\n查看全部：{link.rstrip("/")}/harvest-review/{sheet["id"]}')
        lines.append('\n逐个核对，全是我们自己的歌再点「审核通过」，整批一起；有不是我们的就点「审核失败」，一首都不发。')
        return '\n'.join(lines)[:4000]

    def sheet_info(self, sid):
        """「查看全部」网页用：这张审核单的每一首。没有这张 → None"""
        b = self.sheets.get(sid)
        if b is None:
            return None
        return {'id': b['id'], 'site': b['site'], 'url': b['url'], 'query': b.get('query', ''), 'status': b['status'],
                'tracks': [{'title': t.title, 'artist': t.artist, 'page': t.page_url} for t in b['tracks']]}

    def decide(self, sid, ok, existing, notify=None, channel='', cookie=''):
        """频道主按了审核单的按钮 → (结果, 首数)。结果：'missing' 没有这张（服务重启过）/ 'done' 已经审过 /
        'busy' 正在抓或发别的，等会儿再点 / 'approved' 开始发 / 'rejected' 不发了。
        channel：发到这个测试频道（空＝正式频道）。cookie：频道主登录过的网站账号（取 VIP 歌的下载地址）"""
        b = self.sheets.get(sid)
        if b is None:
            return 'missing', 0
        if b['status'] != 'review':
            return 'done', len(b['tracks'])
        if not ok:
            b['status'] = 'rejected'
            return 'rejected', len(b['tracks'])
        if self.running():
            return 'busy', len(b['tracks'])
        b['status'] = 'approved'
        self.state = self._fresh('post', b['url'], b['site'])
        self.state['channel'] = channel
        seen = {norm(t) + '|' + norm(a) for t, a in existing}
        self.task = asyncio.create_task(self._post(b, seen, notify, channel, cookie))
        return 'approved', len(b['tracks'])

    # ── 通过后：一首首发进频道 ──

    async def _post(self, sheet, seen, notify, channel='', cookie=''):
        st = self.state
        download = getattr(sheet.get('adapter'), 'download', None)  # 下载地址要现取的网站
        send = (lambda *a: self.send(*a, channel=channel)) if channel else self.send
        try:
            for t in sheet['tracks']:
                row = {'title': t.title, 'artist': t.artist, 'page': t.page_url}
                st['results'].append(row)
                if song_key(t) in seen:  # 审核期间别的方式搬进来了
                    row['status'], row['reason'] = 'skipped', '小橘音乐里已经有了'
                    st['skipped'] += 1
                    continue
                try:
                    if download:
                        t = await download(t, self.http, cookie)
                    new_id = await self.publish(t, http=self.http, send=send)
                except UploadError as e:
                    row['status'], row['reason'] = 'failed', str(e)
                    continue
                except Exception as e:  # noqa: BLE001 — 一首出错不影响后面的
                    log.exception('publish failed')
                    row['status'], row['reason'] = 'failed', type(e).__name__
                    continue
                seen.add(song_key(t))
                row['status'], row['id'] = 'copied', new_id
                st['copied'] += 1
                if new_id:
                    st['new_ids'].append(new_id)
                await self.sleep(self.pause)  # 慢慢发，免得被限流
            st['status'] = 'done'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('post failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
        await self._notify(notify, (self.report(), None))

    def report(self):
        st = self.state
        rows = st['results']
        crawl = st.get('kind') == 'crawl'
        if st['status'] == 'error':
            head = f'⚠️ 出错了：{st["error"]}' + ('' if crawl else f'（已发 {st["copied"]} 首）')
        elif not rows:
            head = f'在{st["site"]}没搜到「{st["query"]}」' if st.get('query') else '这个网址里没找到歌'
        elif crawl:
            head = f'📥 从{st["site"]}' + (f'搜「{st["query"]}」' if st.get('query') else '') + f'抓到 {st["review"]} 首，等你审核（审核单另发）' + (f'，跳过 {st["skipped"]} 首' if st['skipped'] else '')
        else:
            head = f'📥 审核通过的发进' + (f'测试频道 @{st["channel"]}' if st.get('channel') else '频道') + f' {st["copied"]} 首' + (f'，没发 {len(rows) - st["copied"]} 首' if len(rows) > st['copied'] else '')
        lines = [head]
        done = [r for r in rows if r.get('status') == 'copied']
        if done:
            lines += ['', '发进频道的：'] + [f'· {r["title"]}' + (f' — {r["artist"]}' if r['artist'] else '') for r in done[:10]]
        other = [r for r in rows if r.get('status') in ('skipped', 'failed')]
        if other:
            lines += ['', '跳过的：' if crawl else '没发的：'] + [f'· {r["title"]}：{r["reason"]}' for r in other[:10]]
            if len(other) > 10:
                lines.append(f'……还有 {len(other) - 10} 首')
        return '\n'.join(lines)[:4000]
