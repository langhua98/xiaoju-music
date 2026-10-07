// cloudflare:workers 的最小替身：只提供 Durable Object 基类
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
