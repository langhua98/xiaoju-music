"""把适配器、授权检查、上传串起来跑一次：贴一个网址 → 找音轨 → 每首检查授权 → 允许的发进频道。

没标授权、认不出授权的不直接跳过：凑成一张审核单发给频道主（和小橘视频的审核单一样，整批「通过 / 失败」），
通过了再发进频道。审核单只存在内存里，服务重启就没了，重新发一次网址就行。

一次只跑一个；结果（每首搬了没有、为什么）记在 state 里，跑完通知频道主。"""

import asyncio
import logging
import re
import secrets
import string

from . import license as lic
from .sites import find_adapter
from .upload import REVIEWED, UploadError, publish

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
        self.sheets = {}  # 审核单编号 → {id, site, url, tracks, reasons, status}

    def running(self):
        return self.task is not None and not self.task.done()

    def check_url(self, url, settings):
        """开始前先看网址能不能搬：→ (适配器, None) 或 (None, 原因)。"""
        a = find_adapter(url)
        if a is None:
            return None, '这个网站还不支持'
        if a.key not in set(settings.get('sites') or ()):
            return None, f'「{a.name}」在搬运设置里关着'
        return a, None

    def start(self, url, settings, existing, notify=None, link=''):
        """settings：{sites: [开着的网站], licenses: [接受的授权代码], limit: 最多搬几首（含待审核的）}
        link：Worker 的网址，审核单里「查看全部」用"""
        if self.running():
            raise RuntimeError('already running')
        adapter, why = self.check_url(url, settings)
        if adapter is None:
            raise ValueError(why)
        self.state = self._fresh(url, adapter.name)
        seen = {norm(t) + '|' + norm(a) for t, a in existing}
        self.task = asyncio.create_task(self._run(adapter, url, settings, seen, notify, link))

    def _fresh(self, url, site):
        return {'status': 'running', 'url': url, 'site': site, 'copied': 0, 'skipped': 0, 'review': 0,
                'review_id': '', 'results': [], 'new_ids': [], 'error': ''}

    async def _publish(self, t, label, row, seen):
        """发一首，结果写进 row 和 state。"""
        st = self.state
        try:
            new_id = await self.publish(t, label, http=self.http, send=self.send)
        except UploadError as e:
            row['status'], row['reason'] = 'failed', str(e)
            return
        except Exception as e:  # noqa: BLE001 — 一首出错不影响后面的
            log.exception('publish failed')
            row['status'], row['reason'] = 'failed', type(e).__name__
            return
        seen.add(song_key(t))
        row['status'], row['id'] = 'copied', new_id
        st['copied'] += 1
        if new_id:
            st['new_ids'].append(new_id)
        await self.sleep(self.pause)  # 慢慢发，免得被限流

    async def _run(self, adapter, url, settings, seen, notify, link):
        st = self.state
        limit = max(1, min(int(settings.get('limit') or 20), 200))
        accepted = settings.get('licenses') or []
        pending = []  # 要频道主审核的：(音轨, 原因)
        try:
            # 多看一些：有的会因为授权、重复被跳过
            async for t in adapter.items(url, limit * 3, self.http):
                if st['copied'] + len(pending) >= limit:
                    break
                row = {'title': t.title, 'artist': t.artist, 'license': t.license, 'page': t.page_url}
                st['results'].append(row)
                verdict, code, why = lic.check(t.license, accepted)  # 每一首都要过授权检查
                row['license_code'] = code
                if verdict == 'skip':
                    row['status'], row['reason'] = 'skipped', why
                    st['skipped'] += 1
                    continue
                if song_key(t) in seen:
                    row['status'], row['reason'] = 'skipped', '小橘音乐里已经有了'
                    st['skipped'] += 1
                    continue
                if verdict == 'review':
                    seen.add(song_key(t))  # 同一页里重复的不进审核单两次
                    row['status'], row['reason'] = 'review', why
                    pending.append((t, why))
                    continue
                await self._publish(t, why, row, seen)
            st['status'] = 'done'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('harvest failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
        sheet = self._add_sheet(adapter.name, url, pending) if pending else None
        if sheet:
            st['review'], st['review_id'] = len(pending), sheet['id']
        if notify and self.say:
            try:
                await self.say(notify, self.report())
                if sheet:
                    await self.say(notify, self.sheet_text(sheet, link), buttons=[[
                        ('✅ 审核通过', f'hv:ok:{sheet["id"]}'), ('❌ 审核失败', f'hv:no:{sheet["id"]}')]])
            except Exception:  # noqa: BLE001
                log.exception('notify failed')

    # ── 审核单 ──

    def _add_sheet(self, site, url, pending):
        sheet = {'id': sheet_id(), 'site': site, 'url': url, 'status': 'review',
                 'tracks': [t for t, _ in pending], 'reasons': [why for _, why in pending]}
        self.sheets[sheet['id']] = sheet
        for old in list(self.sheets)[:-KEEP_SHEETS]:
            del self.sheets[old]
        return sheet

    def sheet_text(self, sheet, link=''):
        n = len(sheet['tracks'])
        lines = [f'🛂 审核单 {sheet["id"]}（{sheet["site"]}，{n} 首没标明授权）', f'网址：{sheet["url"]}', '']
        for t, why in list(zip(sheet['tracks'], sheet['reasons']))[:8]:
            lines.append(f'· {t.title}' + (f' — {t.artist}' if t.artist else '') + f'：{why}\n  {t.page_url}')
        if n > 8:
            lines.append(f'……还有 {n - 8} 首')
        if link:
            lines.append(f'\n查看全部：{link.rstrip("/")}/harvest-review/{sheet["id"]}')
        lines.append('\n逐个打开来源核对过、确认能转载再点「审核通过」，整批一起；不确定就点「审核失败」，一首都不发。')
        return '\n'.join(lines)[:4000]

    def sheet_info(self, sid):
        """「查看全部」网页用：这张审核单的每一首。没有这张 → None"""
        b = self.sheets.get(sid)
        if b is None:
            return None
        return {'id': b['id'], 'site': b['site'], 'url': b['url'], 'status': b['status'],
                'tracks': [{'title': t.title, 'artist': t.artist, 'license': t.license, 'page': t.page_url, 'reason': why}
                           for t, why in zip(b['tracks'], b['reasons'])]}

    def decide(self, sid, ok, existing, notify=None):
        """频道主按了审核单的按钮 → (结果, 首数)。结果：'missing' 没有这张（服务重启过）/ 'done' 已经审过 /
        'busy' 正在搬别的，等会儿再点 / 'approved' 开始发 / 'rejected' 不发了"""
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
        self.state = self._fresh(b['url'], b['site'])
        seen = {norm(t) + '|' + norm(a) for t, a in existing}
        self.task = asyncio.create_task(self._run_approved(b, seen, notify))
        return 'approved', len(b['tracks'])

    async def _run_approved(self, sheet, seen, notify):
        st = self.state
        try:
            for t in sheet['tracks']:
                row = {'title': t.title, 'artist': t.artist, 'license': t.license, 'page': t.page_url, 'license_code': None}
                st['results'].append(row)
                if song_key(t) in seen:
                    row['status'], row['reason'] = 'skipped', '小橘音乐里已经有了'
                    st['skipped'] += 1
                    continue
                await self._publish(t, REVIEWED, row, seen)
            st['status'] = 'done'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('approved harvest failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
        if notify and self.say:
            try:
                await self.say(notify, self.report())
            except Exception:  # noqa: BLE001
                log.exception('notify failed')

    def report(self):
        st = self.state
        rows = st['results']
        if st['status'] == 'error':
            head = f'⚠️ 搬运出错了：{st["error"]}（已搬 {st["copied"]} 首）'
        elif not rows:
            head = '这个网址里没找到音频'
        else:
            head = f'📥 从{st["site"]}搬了 {st["copied"]} 首，跳过 {st["skipped"]} 首'
            if st.get('review'):
                head += f'，{st["review"]} 首没标明授权、等你审核（审核单另发）'
        lines = [head]
        done = [r for r in rows if r.get('status') == 'copied']
        if done:
            lines += ['', '搬进来的：'] + [f'· {r["title"]}（{lic.LABELS.get(r["license_code"]) or REVIEWED}）' for r in done[:10]]
        other = [r for r in rows if r.get('status') in ('skipped', 'failed')]
        if other:
            lines += ['', '没搬的：'] + [f'· {r["title"]}：{r["reason"]}' for r in other[:10]]
            if len(other) > 10:
                lines.append(f'……还有 {len(other) - 10} 首')
        return '\n'.join(lines)[:4000]
