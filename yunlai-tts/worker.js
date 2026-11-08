// Yunlai 机器人（langhua98/xiaoju-remote 的机器人模式）的语音：Cloudflare Workers AI 上的 MeloTTS（myshell-ai/melotts，MIT）。
// 和小橘音乐没有关系，只是借这个仓库的 Cloudflare 部署令牌（部署：Actions → Deploy yunlai-tts）。
// 接口和流式服务 Space 的 /tts 一样，小橘遥控把「语音服务地址」换成 https://yunlai-tts.langhua98.workers.dev 就能用：
//   GET /tts?text=一句话&voice=…&speed=…  → audio/mpeg（voice、speed 收下但 MeloTTS 用不上，只有一个中文女声）
// 免费额度：Workers AI 每天 1 万 Neurons。合成过的句子放进 Cloudflare 缓存（一天），再要直接回，不花额度。
// 不要密钥（机器人直接调），一次最多 300 字。

const MODEL = '@cf/myshell-ai/melotts';
const MAX_TEXT = 300;
const CORS = { 'Access-Control-Allow-Origin': '*' };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// Workers AI 回的可能是 { audio: base64 }，也可能直接是二进制流，两种都接住
async function toBytes(out) {
  if (out instanceof ReadableStream) return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out && typeof out.audio === 'string') {
    const bin = atob(out.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  throw new Error('看不懂模型的输出');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET' } });
    if (url.pathname === '/health' || url.pathname === '/') return json({ ok: true, model: MODEL });
    if (url.pathname !== '/tts') return json({ detail: 'not found' }, 404);

    const text = (url.searchParams.get('text') || '').trim();
    if (!text) return json({ detail: '缺 text' }, 400);
    if (text.length > MAX_TEXT) return json({ detail: `一次最多 ${MAX_TEXT} 字，请分句` }, 413);
    const lang = url.searchParams.get('lang') || 'zh';

    // 缓存键只看文字和语言
    const key = new Request(`https://yunlai-tts.cache/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), 'X-Cache': 'HIT' } });

    let bytes;
    try {
      bytes = await toBytes(await env.AI.run(MODEL, { prompt: text, lang }));
    } catch (e) {
      return json({ detail: `合成失败：${e && e.message ? e.message : e}` }, 502);
    }
    const headers = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400', ...CORS };
    ctx.waitUntil(cache.put(key, new Response(bytes, { headers })));
    return new Response(bytes, { headers: { ...headers, 'X-Cache': 'MISS' } });
  },
};
