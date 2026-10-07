"""上传：把一首允许转载的音频下载下来，必要时转成 mp3，带上署名和授权信息发进频道。

不判断授权（调用前已经由 license.check 判断过），也不管从哪个网站来（那是 sites.py 的事）。"""

import asyncio
import subprocess

MAX_BYTES = 200 * 1024 * 1024   # 再大的不下（几个小时的录音）
PLAYABLE = ('mp3', 'm4a', 'aac')  # 手机浏览器都能放的，原样发；别的（ogg、flac、wav）转成 mp3


def caption(track, license_label):
    """帖子说明：歌名、作者、授权、原始链接。网站据此显示来源，转载的人也能看到授权要求。"""
    lines = [track.title + (f' — {track.artist}' if track.artist else '')]
    lines.append(f'授权：{license_label}')
    lines.append(f'来源：{track.page_url}')
    lines.append('原作者以上述授权公开发布，转载请保留署名和来源。')
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


async def publish(track, license_label, *, http, send, convert=to_mp3, measure=probe_seconds):
    """下载 → 转格式 → 发帖。send(数据, 文件名, 歌名, 作者, 秒数, 说明) 返回新帖子的消息号。
    出错抛 UploadError（带给人看的原因）。"""
    if track.size and track.size > MAX_BYTES:
        raise UploadError(f'文件太大（{track.size // 1024 // 1024} MB）')
    data = await http.get_bytes(track.audio_url, MAX_BYTES)
    ext = track.ext or 'mp3'
    if ext not in PLAYABLE:
        data = await asyncio.to_thread(convert, data)
        if not data:
            raise UploadError(f'{ext} 格式转不成 mp3')
        ext = 'mp3'
    seconds = track.duration or await asyncio.to_thread(measure, data)
    safe = ''.join(c for c in (track.artist + ' - ' if track.artist else '') + track.title if c not in '\\/:*?"<>|')[:100] or 'audio'
    return await send(data, f'{safe}.{ext}', track.title, track.artist, int(seconds), caption(track, license_label))


class UploadError(Exception):
    pass
