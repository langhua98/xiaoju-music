# 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）

把 Telegram 频道 [@xiaojumusic](https://t.me/xiaojumusic) 里的音频变成**打开网页就能直接播放**的
歌单，不需要登录 Telegram。代码从 [langhua98/Linggo](https://github.com/langhua98/Linggo) 的 `xiaoju-music/` 搬到这个仓库。

- 播放页：https://xiaoju-music.langhua98.workers.dev
- 分享单曲：在网址后加 `#消息号`，例如 `…/#4`
- 管理页：https://xiaoju-music.langhua98.workers.dev/admin（用管理密钥登录，用来移除频道里已删掉的歌）

## 工作原理

音频文件一直存在 Telegram 里。Worker 在服务端持有机器人（@xiaoju_music_bot）的 token，
把「频道消息号」换成浏览器能直接播放的地址。频道里新发的音频由 webhook 推过来，自动登记。

- **20 MB 以内**：Worker 用官方 Bot API 的 `getFile` 取文件，按浏览器的 Range 透传。
- **超过 20 MB**：`getFile` 取不了。Worker 把 Range 请求转给 Hugging Face 上的流式服务
  （[`streamer/`](streamer/)）：它以机器人身份走 MTProto（没有 20 MB 限制），浏览器要哪一段，
  就从 Telegram 现取哪一段、边取边传。不落盘、不切片，拖进度条直接跳。

流式服务在 Hugging Face 免费版上，闲置约 48 小时会休眠。休眠时 Worker 转过去的第一个请求会把它叫醒，
Worker 先回 `503` + `Retry-After`，播放页提示「正在唤醒」并每 10 秒重试一次（最多等 2 分钟）。
所以大文件的播放依赖这个 Space 在线；小文件完全不经过它。

## 路由

| 路径 | 作用 |
|---|---|
| `GET /` | 播放页（`page.html`：深色沉浸式，电脑两栏、手机歌单 + 迷你条 + 全屏播放（往下拖收起、往上拖下一首）；「全部 / 歌单 / 我喜欢 / 歌手」四个页签（歌单是管理员编的），歌手页按歌手把歌归在一起，合唱的歌几位歌手底下都有） |
| `GET /l/<消息号>` | 歌词 JSON：`{src, synced, lines: [[秒, 这句], …]}`（`synced` 为 false 时只有文字、秒是 null）。先看数据库，没有就去 LRCLIB、网易云找，找到（或确定没有）就存起来，见下方「歌词」 |
| `GET /v/<消息号>` | 音柱数据：这首歌每秒 15 帧、每帧 16 个频段（50 Hz～5 kHz）各多响，0～15，两个值一个字节（开头 `XV` + 版本 + 帧率 + 频段数）。第一次请流式服务 `/viz` 把整首歌取下来用 ffmpeg 解码算好，存进数据库 `viz` 表（算不了记空字符串）；播放页按播放进度画音柱，不用 Web Audio，iPhone 锁屏、切后台照常出声 |
| `GET /c/<消息号>` | 封面：优先用音乐文件自带的缩略图（新歌走 Bot API，更早的歌请流式服务用 MTProto 取）；没有就从频道的图片帖里随机挑一张（新图片帖由 webhook 记下，更早的由流式服务 `/photos` 按消息号扫出来）。挑定后存进数据库（`own` 列记着是自带的还是配的图），不再变。带 `?art=1` 时只给自带的专辑图，配的频道图片回 404——播放页和歌曲列表这样请求，没有专辑图的歌由网页画文字封面（歌名 + 歌手）；歌单宫格不带它 |
| `GET /api/tracks` | 歌曲 JSON，新的在前；每首带 `big`（超过 20 MB）和 `playable`，不含 `file_id`；`playlists` 是管理员编的歌单 |
| `GET /a/<消息号>` | 音频流，支持 Range（iOS Safari 开始播放、拖进度条都要 206）；加 `?dl=1` 变成下载 |
| `POST /tg-webhook` | Telegram 推送频道新帖，音频自动登记；回复某首歌发的 `.lrc` 文件就是这首的歌词 |
| `GET /admin` | 管理页（`admin.html`） |
| `GET /admin/api/state` / `POST /admin/api/remove` | 管理页数据 / 从歌单移除一首（`{track}`） |
| `GET/POST /admin/api/sources` | 搬歌用的「音乐来源频道」名单（`{sources: [用户名…]}`）。频道主账号加入这些频道（静音、归档）后，流式服务的 `/search/global` 一次搜遍，只认名单里的频道 |
| `POST /admin/api/reshuffle-photo-covers` | 频道里新加了图片后用：没有自带封面、用着频道图片的歌清掉封面，下次打开时从现在的图库里重新挑 |
| `POST /admin/api/ban-cover` | 这首现在的封面不要了（`{track}`）：用这张图的歌都改用频道图片，以后也不再用它 |
| `POST /admin/api/playlists` | 整体设置歌单：`{playlists: [{id?, name, cover?, tracks: [消息号…]}]}`，顺序就是显示顺序；带 `id` 的原地改，没列出的删掉 |

管理接口都要 `Authorization: Bearer <ADMIN_KEY>`，响应不带 CORS 头。

## 数据

在 Durable Object `Library` 的 SQLite 里（强一致，也没有 KV list 每天 1000 次的限制）：

- `songs`：每首歌一行，`rec` 是完整记录（含 `file_id`、大小、类型、标题等）；
- `covers`：每首歌定下来的封面（base64 文本；`mime='none'` 表示频道里连图片都没有）。FLAC 占大多数且没有内嵌封面，
  所以大多数歌用的是频道图片；
- `logo_covers`：不当封面用的图（别的频道的台标）。同一张图被 8 首以上的歌当封面会自动记进来，也可以用 `ban-cover` 手动加；
- `photos`：频道里的图片帖（`file_id` 为空的是流式服务扫出来的老帖，由它下载）；
- `lyrics`：每首歌的歌词原文，`src` 是 `lrclib` / `netease` / `manual`（频道里手动发的）/ `none`（确定没有）；
  `retry_at` 不为 0 时，过了这个时间再去外面找一次；
- `playlists`：管理员编的歌单（`pos` 顺序、`name`、`cover` 封面用哪首歌的消息号、`tracks` 消息号 JSON 数组）；
- `config`：`migrated`（已从 KV 迁移过）。

**收藏（我喜欢）不在服务器上**：存在各人浏览器的 localStorage 里（`xm-favs`，消息号数组，新收藏的在前；
页签、从哪一页点的歌之类的偏好在 `xm-prefs`）。所以换设备、换浏览器看不到，清网站数据就没了。
在「我喜欢」里点的歌，上一首/下一首只在收藏里切。

`Library` 启动时会做两次性的迁移：最早版本存在 KV（`TRACKS`）里的 `t:<消息号>` 记录搬进来；
试过「切片」方案的那一版留下的 `tracks` 表、`chats` 表和仓库频道配置，搬完或删掉。

## 歌词

播放页点唱片（或歌名旁边的歌词按钮）切到歌词：正在唱的那句居中、亮起来，点某一句就跳过去；唱片那一面在歌手下面显示正在唱的这一句。

**自动找**：某首歌第一次被人打开时，Worker 先查 [LRCLIB](https://lrclib.net)（公开的歌词库），没有再问网易云
（用的是它网页版的接口，不是公开 API，哪天改了就只剩 LRCLIB）。只要歌名、歌手对得上，**时长相差 3 秒以内**
的带时间轴歌词；时长对不上（多半是 DJ 版、Live 版这类别的版本）就退一步，只显示文字、不跟着滚。
找到什么都存进 `lyrics` 表，以后不再出去找。完全没有的 14 天后再找一次，只有文字的 30 天后再找一次；
有一边正好出错时 1 天后就再找。

**手动配**：在频道里**回复**那首歌，发一个 `.lrc` 文件，就是这首的歌词，自动找到的盖不掉它；再回复一个新的就换掉。
不回复的话，按文件名找（`歌名.lrc` 或 `歌手 - 歌名.lrc`），只有唯一一首对得上才算。
UTF-8、GBK、UTF-16 编码都认；配上之后可以把频道里的这条 `.lrc` 删掉，歌词已经存在数据库里了。

## Cloudflare 配置

| 项 | 值 |
|---|---|
| Worker 名 | `xiaoju-music` |
| 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| Durable Object | 绑定名 `LIB`，类 `Library`（SQLite，迁移标签 `v1`），位置提示 `apac` |
| KV（旧） | `xiaoju-music-tracks`，id=`738216f3f7d64f1ab143128406d1b35e`，绑定名 `TRACKS`，只用于迁移 |
| Secret | `TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`、`STREAMER_KEY` |
| 普通变量 | `CHANNEL_ID=-1003817921075`、`CHANNEL_USERNAME=xiaojumusic`、`STREAMER_URL`（流式服务地址，空＝大文件不能播放） |
| Telegram webhook | `…/tg-webhook`，`allowed_updates=["channel_post","edited_channel_post"]` |

**secret 绝不能写进仓库**（这个仓库是公开的，GitHub Pages 会把它原样发布出去）。
`TG_WEBHOOK_SECRET` 在 Cloudflare 里读不回来；丢了就生成一个新的，同时更新 Worker 的 secret 和
Telegram 的 webhook（见下方「重设 webhook」）。

## 部署流式服务

流式服务（[`streamer/`](streamer/)）和小橘视频**合用** Hugging Face 的 Space `langhua1998/douyin-proxy`：
视频的流式服务在根路径，音乐的放在 Space 的 `music/` 目录、挂在 **`/m`** 下，所以 Worker 的
`STREAMER_URL` 是 `https://langhua1998-douyin-proxy.hf.space/m`。（2026 年 9 月起免费账号新建 Docker Space 要 PRO
订阅，已有的这个还能免费跑，所以合用。）音乐起不来只影响 `/m`，视频照常跑。

两边的机器人、密钥不一样，音乐自己的存成 `MUSIC_` 开头的 secret（Space → Settings → Variables and secrets）：

| 名字 | 内容 |
|---|---|
| `MUSIC_TG_BOT_TOKEN` | 音乐机器人 @xiaoju_music_bot 的 token（和本 Worker 的 `TG_BOT_TOKEN` 相同） |
| `MUSIC_STREAMER_KEY` | 和本 Worker 的 `STREAMER_KEY` 相同（和视频的不是同一个） |
| `MUSIC_TG_USER_SESSION` | （可选）@xiaojumusic 频道主账号的登录凭证；不设就用视频那边的 `TG_USER_SESSION`（同一个人的账号时） |

`TG_API_ID`、`TG_API_HASH` 两边共用。`MUSIC_TG_BOT_TOKEN` 和 `MUSIC_STREAMER_KEY` 都设了才会挂上 `/m`。

更新代码：在 [langhua98/xiaoju-video](https://github.com/langhua98/xiaoju-video) 的 Actions 里跑 **Deploy streamer**，
它把视频的 `streamer/` 和本仓库 `main` 上的 `streamer/app.py`、`streamer/harvest/` 一起推到 Space，Space 自动重新构建。
Space 的 `Dockerfile`、`requirements.txt` 归视频仓库管：音乐要加新的 Python 依赖，记得也加进视频仓库的
`streamer/requirements.txt`。**推之前先在机器人里发「统计」确认没有正在搬的歌**：Space 一重新构建，正在跑的搬歌就断了，
排队的只在它的内存里；视频那边正在转的作品也会断。

本仓库的 `streamer/Dockerfile` 留着，以后音乐有了自己的 Space 可以直接用（那时环境变量不用带 `MUSIC_` 前缀）。

## 改完代码后

1. 跑本地测试（都不联网）：

   ```bash
   node test.mjs                                          # Worker：模拟 Durable Object、Telegram、流式服务
   cd streamer && python -m pytest -q                       # 流式服务（取文件、搬歌、贴网址搬自己的歌）
   ```

2. 重新部署 Worker。`keep_bindings` 会保留线上已有的 secret；迁移 `v1` 已经做过，平时部署**不要**再带
   `migrations`（以后新增 Durable Object 类时才需要，写成 `{"old_tag":"v1","new_tag":"v2",...}`）。
   Cloudflare API token 从环境变量 `CLOUDFLARE_API_TOKEN` 读（用「Edit Cloudflare Workers」模板建）：

   ```bash
   ACC=aca35ff5f62ae4208757219dbc3b489b
   KV=738216f3f7d64f1ab143128406d1b35e
   STREAMER_URL=https://langhua1998-douyin-proxy.hf.space/m    # 没部署流式服务就写空字符串
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-01-01\",\"keep_bindings\":[\"secret_text\"],\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"TRACKS\",\"namespace_id\":\"$KV\"},{\"type\":\"durable_object_namespace\",\"name\":\"LIB\",\"class_name\":\"Library\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_ID\",\"text\":\"-1003817921075\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_USERNAME\",\"text\":\"xiaojumusic\"},{\"type\":\"plain_text\",\"name\":\"STREAMER_URL\",\"text\":\"$STREAMER_URL\"}]};type=application/json" \
     -F 'worker.js=@worker.js;type=application/javascript+module' \
     -F 'page.html=@page.html;type=text/plain' \
     -F 'admin.html=@admin.html;type=text/plain'
   ```

   `page.html`、`admin.html` 以 `text/plain` 上传，就是 Workers 的文本模块，`worker.js` 里 `import` 进来当字符串用。
   或者在 GitHub 的 Actions 里跑 **Deploy worker**（先跑 `node test.mjs`，过了才用同样的 curl 部署；要仓库 secret `CLOUDFLARE_API_TOKEN`）。
   也可以在本目录用 `wrangler deploy`（`wrangler.toml` 已写好绑定、迁移和 `.html` 文本模块规则，secret 不受影响）。

3. 改了流式服务：推到本仓库 `main` 后，去 xiaoju-video 的 Actions 跑 **Deploy streamer**（见上方「部署流式服务」）。

## 日常维护

- **移除一首**（频道里删帖不会通知机器人）：在管理页点「移除」。
- **换机器人 token**（在 BotFather 发 `/revoke` 之后）：Worker 和流式服务都要换。

  ```bash
  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music/secrets" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"TG_BOT_TOKEN","text":"<新 token>","type":"secret_text"}'
  ```

  流式服务在 Space 的 Settings 里改 `MUSIC_TG_BOT_TOKEN`。换完用新 token 打开
  `https://api.telegram.org/bot<新 token>/getWebhookInfo`，确认 `url` 还指向本 Worker；不在了就重设。

- **重设 webhook**（换了 Worker 地址、换了 `TG_WEBHOOK_SECRET`，或 webhook 丢了）：

  ```bash
  curl "https://api.telegram.org/bot<机器人 token>/setWebhook" \
    -d url=https://xiaoju-music.langhua98.workers.dev/tg-webhook \
    -d secret_token=<与 Worker 的 TG_WEBHOOK_SECRET 相同> \
    --data-urlencode 'allowed_updates=["channel_post","edited_channel_post","message","callback_query"]'
  ```

  设了 webhook 之后 `getUpdates` 不再可用（两者互斥）。

- **补登记旧帖**：机器人加入频道之前发的帖子 webhook 收不到。当初 #4、#5 是这样补的：用
  `forwardMessage` 把旧帖静音转发回频道，从返回里读出 `audio`/`document`，立刻 `deleteMessage`
  删掉转发出来的副本，再把 `message_id`、`date` 换回原帖的值，拼成一个 `channel_post` update，
  带着 `X-Telegram-Bot-Api-Secret-Token` 头 POST 给 `/tg-webhook`。

## 机器人和自动搬歌

机器人 @xiaoju_music_bot 收私聊（webhook 要带 `message`、`callback_query`，见上面「重设 webhook」）。
私聊和按钮由 Worker 先回 200，再在后台处理（`botUpdate`）；要搜歌、搬歌的转给流式服务。

- **频道主**：频道的创建者（Worker 第一次用时问 `getChatAdministrators`，记在 config 的 `ownerId`）。能发：
  - `搜 歌名`：在来源频道里搜（流式服务 `/search/global`），列出来带「搬 N」按钮，点了走 `/copy/pick`。
  - `搬 @频道 N`：流式服务 `/copy/start`（只要中文、60 秒～20 分钟、查重），搬完机器人私聊通知。
  - `找 歌名`：在歌库里找，按钮可以加入/移出歌单、删除（删除只从歌库去掉，频道里的帖子不动，和管理页「移除」一样）。
  - `统计`：歌库总数、最近 1/7 天新增、上次夜里自动搬、各歌单首数。
  - 直接发歌名：和听众求歌一样，不限次。
- **听众求歌**：发歌名。歌库里有就回网页链接（`/#消息号`）；没有就交给流式服务 `/fulfill`：在来源频道里搜，
  按 `rank_requests` 挑最像的一首（歌名一样优先；DJ 版、伴奏、片段等用户没提就往后排；60 秒～15 分钟），
  搬进频道后机器人直接回链接；禁止转发的跳过试下一首。每人每 24 小时最多 10 次（`asks` 表）。
- **新歌自动分歌单**：webhook 收到的新音频帖（第一次登记的，不是编辑）按 `genresOf` 放进已有的同名歌单：
  歌名关键词（DJ/Remix/串烧 → DJ 劲爆，重低音/Bass → 重低音，Live → 现场 Live……）加歌手名单
  （`GENRE_ARTISTS`），一首可以进几个；都对不上但有歌手的进「华语流行」；MV、综艺、伴奏之类不进。
- **贴网址搬自己的歌**（频道主私聊机器人发网易云网址或 App 分享的整段文字，可以带数量：`网址 30`）：
  流程是 **抓取 → 审核单 → 频道主确认是我们的歌点「通过」→ 发进频道**，抓取本身不发帖。流式服务的 `harvest/` 里分三块——
  `sites.py` 网站适配器（现在只有网易云音乐：单曲、歌单、专辑、歌手的 `?id=`，网页版带 `#/` 的也行，`163cn.tv` 短链接先跟着跳转；
  网易云的接口都经 **api-enhanced** 调用，见下方「网易云接口和登录」），
  `upload.py` 上传（下载，不是 mp3/m4a 的用 ffmpeg 转 mp3，用频道主账号发帖——机器人收不到自己发的帖子），
  `job.py` 串起来：抓歌、和库里查重、限数量，凑成审核单；通过后再查一次重、逐首发帖，发完私聊频道主发了/没发（及原因）。
  **审核单**（和小橘视频的做法一样）：机器人私聊频道主，列出每首的歌名、歌手、网易云链接，带「✅ 审核通过 / ❌ 审核失败」两个按钮，
  整批一起，失败的一首都不发；「查看全部」是 Worker 的 `/harvest-review/<编号>`（编号随机 14 位）。
  审核单只存在流式服务的内存里（最多 20 张），重启后点按钮会提示过期，重新发一次网址就行。
  帖子说明写歌名、作者、`授权：频道主确认是小橘音乐自己的作品`、`来源：` 网易云链接。
  Worker 收到说明里有「授权：」「来源：」的新帖：设置里指定了歌单就放进去，否则按类型分（分不出类型不塞「华语流行」）。
  设置（`搬运数量 N`；`搬运歌单 名字|自动`，名字不存在就新建歌单；`搬运频道 @测试频道|正式`）存在 config 的 `harvest`。
  **测试频道**：设了 `搬运频道 @某频道` 后，审核通过的歌发到那个频道（频道主账号要是它的管理员），
  Worker 只登记正式频道的帖子，所以测试发的不进小橘音乐。试好了发 `搬运频道 正式` 改回来。
  加新网站：在 `sites.py` 写一个适配器（`key`、`name`、`match`、`items`）放进 `ADAPTERS`，再在 Worker 的 `HARVEST_SITES` 里加名字。
- **爬 关键词**（频道主私聊机器人发「爬 歌名或歌手」，可以带数量：`爬 小橘 30`）：不用网址，流式服务直接在网易云上搜
  （api-enhanced 的 `/cloudsearch`，网易云排好的顺序），后面和贴网址一样：查重、限数量、出审核单，点「通过」才发进频道。
  搜出来的不一定都是我们的歌，审核单里要逐首核对。能搜的网站在适配器里多写一个 `search(query, limit, http)`。
- **网易云接口和登录**：网易云的接口（搜歌、单曲/专辑/歌单/歌手、取下载地址、扫码登录）不自己写，用
  [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)（npm 包 `@neteasecloudmusicapienhanced/api`，
  版本固定在 xiaoju-video 的 `streamer/Dockerfile` 里）。镜像构建时装到 `/opt/netease-api`，音乐的流式服务启动时用 `node` 在
  `127.0.0.1:3017` 拉起它（外面访问不到；它的输出丢掉，因为会打出登录 cookie）。没装时贴网址、爬歌报错，播放不受影响。
  它的「解灰」（`ENABLE_GENERAL_UNBLOCK`、`unblock=true`，从别的平台找同名歌顶替）**不要开**：搬的是我们传到网易云的那个文件。
  **VIP 歌要登录**：频道主发「网易云登录」，流式服务（`POST /netease/login`）用机器人发二维码，扫码确认后把 cookie 交到 Worker 的
  `POST /netease-cookie`（带流式服务密钥），存在 config 的 `netease`；审核通过时 Worker 把它带给 `/harvest/review`，
  发帖前才用它取下载地址（`/song/url/v1`，320k）。只给试听片段（会员过期）或不给地址的那首不发，报原因。
  看广告领的会员 `vipType` 显示 0，但照样能下 VIP 歌（2026 年 10 月试过，VIP 歌给 128k）；会员几小时到一天就过期，过期了在 App 里续上。
- **夜里自动搬**：Worker 的定时任务 `0 19 * * *`（北京时间凌晨 3 点）跑 `nightly`：叫醒流式服务，读上一晚
  `/auto/status`，把每个来源频道「看到的最大消息号」合进 config 的 `auto.state`，再 `/auto/start`：每个频道只看
  比上次新的帖子（`min_id`），最多 30 首；第一次只看最新 10 首；禁止转发、出错的频道跳过。搬完机器人私聊频道主。
  手动跑一次：`POST /admin/api/auto-run`；看记录：`GET /admin/api/auto-state`。
  定时任务的设置（部署脚本不会动它，改时间才需要）：

  ```bash
  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music/schedules" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" -d '[{"cron":"0 19 * * *"}]'
  ```

## 限制

- 机器人只能私聊和它说过话的人（Telegram 的规定）：频道主、听众都要先在机器人那里点一次「开始」。

- 大概四分之一的歌（多是 DJ 版、翻唱）两个歌词库里都没有，要在频道里手动配 `.lrc`。
- LRCLIB 上不少中文歌词是繁体字（2026 年 9 月存下的 207 首里有 103 首），原样显示。
- 大文件的播放依赖流式服务在线：Space 休眠时第一次播放要等它醒（约 1～2 分钟），重启时正在播的会中断后自动重试。
- 频道里删掉的帖子不会自动从歌单消失，在管理页移除。
- 查重：频道里新发的歌如果和已有的歌名、歌手一样、时长相差 3 秒以内，就不进歌单（帖子本身还在频道里）。
- 收藏只存在当前浏览器里，不跨设备同步。iPhone 的 Safari 还会在连续 7 天（按用过 Safari 的天数算）没打开这个网站后
  清掉它存的数据，收藏也在内。
- `workers.dev` 在中国大陆被屏蔽，不开 VPN 打不开；要给国内用户用，需要绑定自定义域名。
- 音频不经 Cloudflare 缓存，每次都从 Telegram 现取，第一次播放首字节约 1～2 秒。
