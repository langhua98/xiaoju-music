"""上传：把一首频道主审核通过的音频下载下来，必要时转成 mp3，带上歌名、作者、来源发进频道。

不判断是不是我们的歌（频道主在审核单里确认过了），也不管从哪个网站来（那是 sites.py 的事）。"""

import asyncio
import subprocess

MAX_BYTES = 200 * 1024 * 1024   # 再大的不下（几个小时的录音）
PLAYABLE = ('mp3', 'm4a', 'aac')  # 手机浏览器都能放的，原样发；别的（ogg、flac、wav）转成 mp3

# 帖子说明里「授权：」一栏。Worker 认「授权：」「来源：」两行，把搬来的歌放进搬运设置里指定的歌单
OWN = '频道主确认是小橘音乐自己的作品'


def caption(track):
    """帖子说明：歌名、作者、授权、原始链接。"""
    lines = [track.title + (f' — {track.artist}' if track.artist else ''), f'授权：{OWN}', f'来源：{track.page_url}']
    return '\n'.join(lines)[:1024]  # Telegram 帖子说明最长 1024 字


def to_mp3(data):
    """任意音频 → mp3（192k）。转不了返回 None。"""
    try:
        r = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'],
                           input=data, capture_output=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout or None


def probe_seconds(data):
    """音频有多长（秒）。网站没给时长时用，量不出来返回 0。"""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', 'pipe:0'],
                           input=data, capture_output=True, timeout=120)
        return float(r.stdout.decode().strip() or 0)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return 0.0


async def publish(track, *, http, send, convert=to_mp3, measure=probe_seconds):
    """下载 → 转格式 → 发帖。send(数据, 文件名, 歌名, 作者, 秒数, 说明) 返回新帖子的消息号。
    出错抛 UploadError（带给人看的原因）。"""
    if track.size and track.size > MAX_BYTES:
        raise UploadError(f'文件太大（{track.size // 1024 // 1024} MB）')
    data = await http.get_bytes(track.audio_url, MAX_BYTES)
    if data[:512].lstrip()[:1] == b'<':  # 跳到了网页（网易云 VIP、下架的歌会跳到 404 页）
        raise UploadError('下载到的是网页不是音频（可能是 VIP 或下架的歌，网站不给下载）')
    ext = track.ext or 'mp3'
    if ext not in PLAYABLE:
        data = await asyncio.to_thread(convert, data)
        if not data:
            raise UploadError(f'{ext} 格式转不成 mp3')
        ext = 'mp3'
    seconds = track.duration or await asyncio.to_thread(measure, data)
    safe = ''.join(c for c in (track.artist + ' - ' if track.artist else '') + track.title if c not in '\\/:*?"<>|')[:100] or 'audio'
    return await send(data, f'{safe}.{ext}', track.title, track.artist, int(seconds), caption(track))


class UploadError(Exception):
    pass
