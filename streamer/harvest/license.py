"""授权检查：明确允许转载的授权（知识共享各类许可、公有领域）直接搬，没标授权、认不出来的交频道主审核。

check(raw, accepted) 对每一首都要调用：raw 是网站给的授权（网址或简称），accepted 是频道主在设置里勾选的授权代码。
写明版权保留的、频道主没勾选的，一律不搬，并给出原因。"""

import re

# 授权代码 → 给人看的名字
LABELS = {
    'cc0': 'CC0（放弃版权）',
    'pd': '公有领域',
    'by': 'CC BY 署名',
    'by-sa': 'CC BY-SA 署名-相同方式共享',
    'by-nc': 'CC BY-NC 署名-非商业',
    'by-nc-sa': 'CC BY-NC-SA 署名-非商业-相同方式共享',
    'by-nd': 'CC BY-ND 署名-禁止演绎',
    'by-nc-nd': 'CC BY-NC-ND 署名-非商业-禁止演绎',
}
ALL = list(LABELS)

_CC_URL = re.compile(r'creativecommons\.org/licenses/([a-z-]+)', re.I)
_CC_TEXT = re.compile(r'\bcc[\s-]*(by(?:[\s-]*(?:nc|nd|sa))*)\b', re.I)
# 写明版权保留：不交审核，直接不搬
_RESERVED = re.compile(r'all\s+rights\s+reserved|版权所有|保留所有权利|rightsstatements\.org/vocab/inc|\bin\s+copyright\b|©', re.I)


def classify(raw):
    """网站给的授权 → 授权代码；认不出来返回 None。"""
    s = (raw or '').strip()
    if not s:
        return None
    low = s.lower()
    if 'publicdomain/zero' in low or re.search(r'\bcc[\s-]*0\b|\bcc[\s-]*zero\b', low):
        return 'cc0'
    if 'publicdomain/mark' in low or re.search(r'\bpublic[\s-]*domain\b|\bpd\b|^pd[\s-]', low):
        return 'pd'
    m = _CC_URL.search(s) or _CC_TEXT.search(s)
    if m:
        parts = [p for p in re.split(r'[\s-]+', m.group(1).lower()) if p]
        if parts and parts[0] == 'by':
            # 规范成 by[-nc][-nd|-sa] 的顺序
            code = 'by' + ('-nc' if 'nc' in parts else '') + ('-nd' if 'nd' in parts else '') + ('-sa' if 'sa' in parts else '')
            return code if code in LABELS else None
    return None


def check(raw, accepted):
    """→ (结论, 授权代码或 None, 原因)。结论：'ok' 直接搬 / 'review' 交频道主审核 / 'skip' 不搬。原因是给频道主看的一句话。"""
    code = classify(raw)
    if code is None:
        shown = (raw or '').strip()[:60]
        if _RESERVED.search(raw or ''):
            return 'skip', None, f'写明了版权保留（{shown}）'
        return 'review', None, f'认不出授权（{shown}）' if shown else '没有授权标记'
    if code not in set(accepted or ()):
        return 'skip', code, f'授权是「{LABELS[code]}」，设置里没勾选'
    return 'ok', code, LABELS[code]
