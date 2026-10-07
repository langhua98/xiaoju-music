"""把适配器、授权检查、上传串起来跑一次：贴一个网址 → 找音轨 → 每首检查授权 → 允许的发进频道。

一次只跑一个；结果（每首搬了没有、为什么）记在 state 里，跑完通知频道主。"""

import asyncio
import logging
import re

from . import license as lic
from .sites import find_adapter
from .upload import UploadError, publish

log = logging.getLogger('streamer.harvest')


def norm(s):
    return re.sub(r'[\W_]+', '', (s or '').lower())


class Harvester:
    def __init__(self, *, http, send, say=None, sleep=asyncio.sleep, pause=3.0, publish_fn=publish):
        self.http, self.send, self.say, self.sleep, self.pause = http, send, say, sleep, pause
        self.publish = publish_fn
        self.task = None
        self.state = {'status': 'idle'}

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

    def start(self, url, settings, existing, notify=None):
        """settings：{sites: [开着的网站], licenses: [接受的授权代码], limit: 最多搬几首}"""
        if self.running():
            raise RuntimeError('already running')
        adapter, why = self.check_url(url, settings)
        if adapter is None:
            raise ValueError(why)
        self.state = {'status': 'running', 'url': url, 'site': adapter.name, 'copied': 0, 'skipped': 0,
                      'results': [], 'new_ids': [], 'error': ''}
        seen = {norm(t) + '|' + norm(a) for t, a in existing}
        self.task = asyncio.create_task(self._run(adapter, url, settings, seen, notify))

    async def _run(self, adapter, url, settings, seen, notify):
        st = self.state
        limit = max(1, min(int(settings.get('limit') or 20), 200))
        accepted = settings.get('licenses') or []
        try:
            # 多看一些：有的会因为授权、重复被跳过
            async for t in adapter.items(url, limit * 3, self.http):
                if st['copied'] >= limit:
                    break
                row = {'title': t.title, 'artist': t.artist, 'license': t.license, 'page': t.page_url}
                st['results'].append(row)
                ok, code, why = lic.check(t.license, accepted)  # 每一首都要过授权检查
                row['license_code'] = code
                if not ok:
                    row['status'], row['reason'] = 'skipped', why
                    st['skipped'] += 1
                    continue
                key = norm(t.title) + '|' + norm(t.artist)
                if key in seen:
                    row['status'], row['reason'] = 'skipped', '小橘音乐里已经有了'
                    st['skipped'] += 1
                    continue
                try:
                    new_id = await self.publish(t, why, http=self.http, send=self.send)
                except UploadError as e:
                    row['status'], row['reason'] = 'failed', str(e)
                    continue
                except Exception as e:  # noqa: BLE001 — 一首出错不影响后面的
                    log.exception('publish failed')
                    row['status'], row['reason'] = 'failed', type(e).__name__
                    continue
                seen.add(key)
                row['status'], row['id'] = 'copied', new_id
                st['copied'] += 1
                if new_id:
                    st['new_ids'].append(new_id)
                await self.sleep(self.pause)  # 慢慢发，免得被限流
            st['status'] = 'done'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('harvest failed')
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
        lines = [head]
        done = [r for r in rows if r.get('status') == 'copied']
        if done:
            lines += ['', '搬进来的：'] + [f'· {r["title"]}（{lic.LABELS.get(r["license_code"], "")}）' for r in done[:10]]
        other = [r for r in rows if r.get('status') in ('skipped', 'failed')]
        if other:
            lines += ['', '没搬的：'] + [f'· {r["title"]}：{r["reason"]}' for r in other[:10]]
            if len(other) > 10:
                lines.append(f'……还有 {len(other) - 10} 首')
        return '\n'.join(lines)[:4000]
