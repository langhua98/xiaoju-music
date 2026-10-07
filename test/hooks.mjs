import { readFile } from 'node:fs/promises';

// Node 里没有 cloudflare:workers 这个内置模块，测试时换成本地替身
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}

// Worker 把 .html 当文本模块导入（部署时以 text/plain 上传），测试里照样变成默认导出的字符串
export async function load(url, context, next) {
  if (url.endsWith('.html')) {
    const text = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return next(url, context);
}
