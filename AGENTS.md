# AGENTS.md · 小橘音乐维护指南（写给 AI 编程助手）

这份文件写给接手维护这个仓库的 AI 编程助手（OpenCode 等）。开工前从头读一遍；**第 6 节「红线」每次都要遵守**。

- `README.md` 是给频道主看的使用、运维手册：每个功能怎么用、线上怎么配。这份文件讲**怎么改代码才不出错**。
- 两份说法对不上时，以代码为准；改代码时顺手把两份文件里对不上的地方一起改掉。
- 仓库是**公开的**。写进仓库的任何东西（代码、注释、提交信息、PR 描述）谁都能看到。

---

## 开工前先记住这 7 条

1. **密钥绝不进仓库**，也不进日志、响应、提交信息、PR 描述（见 6.1）。
2. **流式服务一重启，内存里的东西全丢**：审核单、正在跑的搬运、刚扫码还没被 Worker 取走的网易云登录。部署前先确认没有活在跑（见 6.2）。
3. **定时任务的 cron 字符串四处必须一字不差**：`worker.js` 的 `FILL_CRON`、`wrangler.toml`、`.github/workflows/deploy-worker.yml`、`README.md`。对不上的话，补全任务会被当成「夜里自动搬」，每 5 分钟跑一次（见 6.3）。
4. **改完先跑两套本地测试，都过了才提交**：`node test.mjs` 和 `cd streamer && python -m pytest -q`（见第 3 节）。
5. **会影响线上的事，频道主明确说了才做**：部署、推 Space、设 webhook、调线上管理接口、用机器人给真人发消息、往频道发帖。合进 `main` **不会**自动部署。
6. **Durable Object 免费额度很紧**：每天最多读 500 万行，Worker 每次调用最多 50 个子请求。不要在每次请求、每次定时任务里扫全表（见 6.5）。
7. **跨文件、跨服务的约定改一边就要改另一边**（见第 7 节），比如歌名、歌手的整理规则、帖子说明的格式、按钮数据的前缀。

---

## 1. 项目是什么

把私密 Telegram 频道「小橘🍊音乐」（id `-1003817921075`）里的音频，变成**打开网页就能听**的歌单。听的人不用登录 Telegram。

**一句话架构**：音频一直存在 Telegram 频道里。**Cloudflare Worker** 拿着机器人 token，把「频道消息号」换成浏览器能播的地址：20 MB 以内走官方 Bot API；更大的文件转给 **Hugging Face 上的流式服务**，它用 MTProto 边取边传。数据（歌、封面、歌词、歌单、设置）存在 Worker 的 **Durable Object（SQLite）**里。

```
                 频道新帖 / 私聊机器人 / 按按钮（webhook）
 Telegram 频道 ───────────────────────────────────────────► Cloudflare Worker  xiaoju-music
 「小橘🍊音乐」 ◄── getFile（≤ 20 MB）、sendMessage ─────── worker.js
      ▲                                                      ├─ Durable Object「Library」（SQLite）
      │ MTProto：读大文件、封面、图片帖                        ├─ page.html（播放页）、admin.html（管理页）
      │ 频道主账号：搬歌、发帖                                 └─ 定时任务：*/5 补封面歌词 + 每小时自检；
      │                                                          0 19 * * * 夜里自动搬、同步小号
 Hugging Face Space（和小橘视频合用，音乐挂在 /m 下）              │
 streamer/app.py（FastAPI + Telethon） ◄── X-Key 请求 ────────────┘（只有 Worker 调流式服务，反过来不行）
   └─ harvest/：贴网易云网址搬歌 → 本机 api-enhanced（127.0.0.1:3017）→ 网易云
```

各部分各管什么：

| 部分 | 在哪 | 管什么 |
|---|---|---|
| Telegram 频道 | 私密频道，id `-1003817921075` | 音频文件真正存放的地方；频道里的图片帖拿来给没封面的歌当封面 |
| 机器人 @xiaoju_music_bot | Bot API（webhook）+ 流式服务里的 MTProto 会话 | 收频道新帖、私聊（频道主管理、听众求歌）、按钮 |
| Worker `xiaoju-music` | https://xiaoju-music.langhua98.workers.dev | 所有网页、API、webhook、机器人逻辑、定时任务 |
| Durable Object `Library` | `worker.js` 里的 `export class Library` | 唯一的数据库（SQLite），名字固定用 `library` 取，位置提示 `apac` |
| 流式服务 | Space `langhua1998/douyin-proxy`，地址 `https://langhua1998-douyin-proxy.hf.space/m` | 超过 20 MB 的音频、老歌封面、图片帖、音柱计算、搬歌、贴网址抓歌、网易云登录 |
| api-enhanced | Space 里由流式服务在 `127.0.0.1:3017` 拉起的 Node 服务 | 网易云接口（搜歌、歌曲详情、下载地址、扫码登录），只给 `harvest/` 用 |
| LRCLIB、网易云网页接口 | Worker 直接请求 `lrclib.net`、`music.163.com/api` | 歌词和专辑封面（这条路不经过 api-enhanced） |

几条主要的数据流：

- **新歌登记**：频道发帖 → Telegram 推 `POST /tg-webhook`（带 `X-Telegram-Bot-Api-Secret-Token`）→ `toRecord()` → 查重 `findSame()` → `upsertTrack()` → `genresOf()` 自动放进同名歌单。
- **播放**：`page.html` → `GET /api/tracks` → `GET /a/<消息号>`（支持 Range）。≤ 20 MB 走 `fromBotApi()`；更大的走 `fromStreamer()` → 流式服务 `/stream/<消息号>`。
- **封面、歌词、音柱**：分别是 `/c/`、`/l/`、`/v/`，第一次请求时去外面找，存进 DO，以后直接给。另外每 5 分钟的定时任务 `fillMissing()` 在后台按顺序补。
- **机器人**：私聊和按钮由 webhook 先回 200，再在 `ctx.waitUntil` 里跑 `botUpdate()` / `botButton()`；要搜歌、搬歌的转给流式服务。流式服务做完后**自己用机器人私聊**频道主（`bot_say`），不回调 Worker。
- **方向只能是 Worker → 流式服务**：Hugging Face 的机房挡掉了 `*.workers.dev`，流式服务连不到 Worker。流式服务里产生的、Worker 需要的数据（比如网易云 cookie）由 Worker 来取（`GET /netease/session`），存进 DO。

历史：代码最早在 `langhua98/Linggo` 的 `xiaoju-music/` 目录，后来搬到这个仓库。流式服务和 `langhua98/xiaoju-video`（小橘视频）合用一个 Space。

---

## 2. 目录和文件

```
.
├── AGENTS.md                 本文件
├── README.md                 频道主看的使用、运维手册（中文）
├── worker.js                 Cloudflare Worker 全部后端逻辑（单文件 ES module，约 2100 行）
├── page.html                 播放页（内联 CSS/JS，作为文本模块打进 Worker）
├── admin.html                管理页（同上，用 ADMIN_KEY 登录）
├── wrangler.toml             wrangler 部署配置：绑定、变量、迁移、定时任务、.html 文本模块规则
├── package.json              只有 "test": "node test.mjs"，没有任何 npm 依赖
├── test.mjs                  Worker 的离线测试（模拟 DO、Telegram、流式服务、LRCLIB、网易云）
├── test/hooks.mjs            Node 加载钩子：cloudflare:workers 换成替身；.html 变成字符串模块
├── test/cloudflare-workers.mjs  DurableObject 基类的替身
├── .github/workflows/deploy-worker.yml  手动触发的「Deploy worker」：先跑 node test.mjs，再部署、设定时任务
└── streamer/                 流式服务（Python 3.12，FastAPI + Telethon）
    ├── app.py                所有 HTTP 接口、Telegram 会话、搬歌（Copier）、求歌、网易云登录、自检、音柱
    ├── harvest/              贴网址 / 爬关键词 / 小号 搬自己的歌
    │   ├── sites.py          网站适配器（现在只有 NetEase）：网址里有哪些歌、热门歌、搜索、现取下载地址
    │   ├── upload.py         下载 → 必要时 ffmpeg 转 mp3 → 写帖子说明 → 发帖
    │   ├── job.py            Harvester：抓取 → 审核单 → 通过后逐首发帖；小号直接发；一次只做一单
    │   ├── net.py            Http：带 UA、限速、429/5xx 重试
    │   └── __init__.py       只有说明
    ├── test_app.py           流式服务离线测试（假 Telegram）
    ├── test_harvest.py       harvest 离线测试（假网站、假发帖）
    ├── requirements.txt      运行依赖（线上真正用的是 xiaoju-video 仓库里的那份，见 4.2）
    ├── Dockerfile            留着备用（线上的 Dockerfile 归 xiaoju-video 管）
    └── README.md             流式服务说明（也是 Space 的元数据头）
```

### 2.1 `worker.js` 按区块看

行号会变，用函数名搜（`grep -n "function 名字" worker.js`）。

| 区块 | 主要函数、常量 | 说明 |
|---|---|---|
| 文件头注释、常量 | `BOT_DOWNLOAD_LIMIT`、`*_WAIT_MS`、`LYRICS_SLACK_S`、`ASK_PER_DAY`、`MSG` | 改阈值先看注释里写的原因 |
| 入口 | `export default { scheduled, fetch }` | 路由全在 `fetch` 里；`scheduled` 按 `controller.cron === FILL_CRON` 分流 |
| webhook | `webhook()`、`toRecord()`、`isAudioDocument()`、`pickMime()` | 只收 `CHANNEL_ID` 的帖子；`.lrc` 配歌词；图片帖记进 `photos`。别的聊天的帖子、`.lrc` 处理出错都照样回 200，免得 Telegram 反复重发、堵住后面的新歌 |
| 管理接口 | `adminApi()` | `/admin/api/*`，`Authorization: Bearer <ADMIN_KEY>`，响应**不带** CORS 头 |
| 歌单 JSON | `tracksFor()`、`trackList()`、`getRec()`、`forget()` | isolate 内存缓存：`listCache` 20 秒、`recCache` 60 秒；改了歌要调 `forget(id)` |
| 封面 | `cover()`、`fetchCover()`、`neteaseCover()`、`photoCover()`、`fetchPhoto()`、`imageFrom()` | 顺序：自带缩略图 → 网易云专辑图 → 频道图片；台标识别 `isLogo()` |
| 音柱 | `viz()` | 请流式服务 `/viz/`，存 base64；空字符串 = 确定算不了 |
| 自检 | `selfCheck()`、`healthLines()`、`CHECK_EVERY_MS` | 跟着 */5 定时任务跑，每小时真跑一次；结果存在 config 的 `health` |
| 后台补全 | `FILL_CRON`、`FILL_BATCH`、`fillMissing()` | 按消息号顺序每次看 8 首（游标 `fillCursor`），连着错 3 次就停；这一轮没有封面歌词要补时才取 `HOT_BATCH`（1）位歌手的热门歌（子请求、CPU 都紧） |
| 歌手热门歌 | `HOT_*`、`artistsOf()`、`neteaseHot()`、`hotOrder()` | 网易云 `search/get`（type=100，名字完全一样才算）→ `artist/top/song?id=`；`/api/tracks` 的 `hot` 由 `hotOrder()` 算 |
| 歌词 | `lyrics()`、`findLyrics()`、`fromLrclib()`、`fromNetease()`、`parseLrc()`、`attachLyrics()`、`decodeText()` | 时长差 3 秒内才用时间轴；手动 `.lrc`（`src='manual'`）自动结果盖不掉 |
| 音频流 | `audio()`、`parseRange()`、`fromBotApi()`、`fromStreamer()`、`passthrough()`、`fetchFile()`、`filePath()` | iOS Safari 必须有 206；流式服务没醒回 503 + `Retry-After` |
| 数据库 | `class Library` | 建表、一次性迁移都在构造函数里；方法都是 RPC，参数和返回值会被结构化克隆 |
| 整理歌名 | `summary()` | 去掉表演者里的 `@频道`、「更多音乐」；没有歌手时拆「歌手 - 歌名」（**和流式服务的 `clean_names()` 必须一致**） |
| 机器人 | `tg()`、`say()`、`ownerId()`、`streamerCall()`、`HELP`、`OWNER_*`、`COMMANDS_VERSION`、`botUpdate()`、`songRequest()`、`owner*()`、`botButton()` | 频道主 = 频道创建者（`getChatAdministrators` 查一次，记在 `ownerId`） |
| 贴网址搬运 | `HARVEST_SITES`、`harvestPanel()`、`showHarvest()`、`setHarvest*()`、`neteaseLogin()`、`neteaseAccount()`、`ownerHarvest()`、`ownerLink()`、`harvestCount()`、`harvestDecide()`、`harvestReviewPage()` | 真正干活的在流式服务的 `harvest/` |
| 小号 | `getAlts()`、`altsText()`、`deleteAlt()`、`syncAlts()` | 网易云主页热门前 50 首，库里没有的不审核直接发 |
| 夜里自动搬 | `nightly()` | 先叫醒流式服务（最多试 10 次、每次间隔 20 秒），同步小号，再 `/auto/start` |
| 自动分歌单 | `GENRE_ARTISTS`、`GENRE_WORDS`、`NOT_A_SONG`、`genresOf()` | 只放进**已经存在**的同名歌单 |
| 小工具 | `sameString()`（定长比较密钥）、`cors()`、`text()`、`json()`、`html()` | 公开接口用 `text()`/`cors()`；管理接口用 `json()`（不带 CORS） |

### 2.2 Worker 的路由

| 路径 | 作用 |
|---|---|
| `GET /` | 播放页 `page.html` |
| `GET /api/tracks` | `{channel, tracks, playlists, hot}`，新的在前；`hot` 是歌手页排序用的 `{歌手: [消息号…]}`；每首有 `big`、`playable`，可能有 `art`；**绝不带 `file_id`** |
| `GET /a/<id>[.ext]`（`?dl=1` 下载） | 音频，支持 Range |
| `GET /c/<id>`（`?art=1` 只要自带专辑图） | 封面 |
| `GET /l/<id>` | 歌词 `{src, synced, lines: [[秒, 这句], …]}` |
| `GET /v/<id>` | 音柱数据（二进制，开头 `XV`） |
| `GET /harvest-review/<14 位编号>` | 审核单的「查看全部」网页 |
| `POST /tg-webhook` | Telegram webhook |
| `GET /admin` | 管理页 `admin.html` |
| `GET /admin/api/state`、`POST /admin/api/remove`、`POST /admin/api/playlists`、`GET/POST /admin/api/sources`、`POST /admin/api/reshuffle-photo-covers`、`POST /admin/api/ban-cover`、`POST /admin/api/auto-run`、`GET /admin/api/auto-state` | 管理接口。管理页（`admin.html`）现在只用 `state` 和 `remove`；其余的没有界面，要带 `Authorization: Bearer <ADMIN_KEY>` 用 curl 调 |

### 2.3 `streamer/app.py` 的接口

除了 `GET /`（健康检查，回 `{"ok": true}`），**每个接口都先 `check_key(request)`**，要求请求头 `X-Key` 等于 `STREAMER_KEY`。

| 接口 | 谁调 | 作用 |
|---|---|---|
| `GET /stream/<id>`、`/thumb/<id>`、`/photos?upto=`、`/photo/<id>`、`/viz/<id>` | Worker | 大文件流、老歌封面、扫图片帖、取图片、算音柱 |
| `POST /login/code`、`/login/verify` | 手动 | 频道主账号登录，生成 `TG_USER_SESSION` |
| `POST /copy/start`、`/copy/pick`、`/auto/start`、`GET /auto/status` | Worker | 从来源频道搬歌（`Copier`），夜里自动搬 |
| `GET /copy/status`、`POST /copy/stop`、`GET /harvest/status`、`GET /harvest/options` | 手动查看、维护用 | 看搬歌、抓歌进度（部署流式服务前用来确认没活在跑），停止搬歌 |
| `POST /fulfill`、`GET /search/global` | Worker | 听众求歌、频道主「搜」 |
| `POST /harvest`、`/harvest/describe`、`/harvest/count`、`/harvest/alts`、`/harvest/review`、`GET /harvest/review/<id>` | Worker | 贴网址 / 爬关键词 / 小号 |
| `POST /netease/login`、`/netease/check`、`GET /netease/session` | Worker | 网易云扫码登录、自检、Worker 取 cookie |
| `GET /search/channels`、`/search/music`、`POST /channels/join`、`/channels/archive-music`、`/channels/check`、`/bot/ask`、`/copy/photos` | 手动维护用 | 找来源频道、加入频道、转图片帖等 |

返回约定：`409` 表示「没准备好 / 正在忙」（忙的时候 `detail` 是 `{busy: 说明}`）；`400` 的 `detail` 是给人看的中文原因；流式服务自己的 `404` 是 JSON，**Hugging Face 的错误页、启动页是 HTML**。Worker 靠 `Content-Type` 是不是 JSON 来区分「确定没有」和「服务还没醒」，这个区分不要弄丢。

### 2.4 数据库（Durable Object `Library` 的 SQLite）

| 表 | 内容 |
|---|---|
| `songs` | `id`（消息号）、`rec`（完整记录 JSON，含 `file_id`、`file_unique_id`、`thumb`、`title`、`performer`、`mime`、`size`、`duration`、`date`、`caption`）、`updated` |
| `covers` | `id`、`mime`（`'none'` = 确定没有）、`data`（base64）、`own`（1 自带 / 0 频道图片）；`data` 上有索引 `covers_data` |
| `logo_covers` | 不当封面用的图（别的频道台标），主键是 base64 |
| `photos` | 频道图片帖：`id`、`file_id`（空 = 流式服务扫出来的老帖） |
| `lyrics` | `id`、`src`（`lrclib`/`netease`/`manual`/`none`）、`lrc`、`retry_at`（0 = 不用再找） |
| `viz` | `id`、`data`（base64；空字符串 = 确定算不了） |
| `playlists` | `id`、`pos`、`name`、`cover`、`tracks`（消息号 JSON 数组） |
| `asks` | 听众求歌记录 `uid`、`at`（每人 24 小时 10 次） |
| `artist_hot` | 歌手在网易云的热门 50 首：`name`（我们这边的歌手名）、`songs`（歌名 JSON 数组，`[]` = 网易云上没这位）、`retry_at`（过了就重取）。整张表记在 DO 内存里 |
| `config` | 键值对，见下表 |

`config` 里的键：

| 键 | 内容 |
|---|---|
| `ownerId` | 频道主的 Telegram 用户 id |
| `cmdsVer` | 已经给频道主设过的菜单版本（对应 `COMMANDS_VERSION`） |
| `harvest` | 搬运设置 `{limit, playlist, channel}` |
| `harvestAsk` | 数完歌等频道主按「抓 N 首」的网址 |
| `sources` | 音乐来源频道名单 |
| `auto` | 夜里自动搬的记录 `{state: {频道: 最大消息号}, runId, lastStart, lastCopied}` |
| `netease` | 网易云登录 `{cookie, nickname, at}`。**cookie 是密钥，不能打日志、不能出现在任何响应里** |
| `neteaseAlts` | 小号列表 `[{id, name, url, at}]` |
| `health` | 自检结果 |
| `fillCursor` | 后台补全看到哪个消息号了 |
| `photosScanned` | 老图片帖扫过没有 |
| `coversV`、`migrated` | 一次性迁移的标记 |

前端只在浏览器里存东西：localStorage 的 `xm-favs`（收藏）、`xm-prefs`（偏好）、`xm-recent`。**不要改这几个键名**，改了每个人的收藏就没了。

---

## 3. 本地验证

两套测试都**不联网**：Telegram、流式服务、LRCLIB、网易云全是模拟的。不需要任何密钥。

### 3.1 Worker

```bash
node test.mjs
```

- 要 **Node 22**（CI 也用 22）。用到 `node:sqlite` 的 `DatabaseSync` 模拟 DO，用 `module.register` 加载 `test/hooks.mjs`。不用 `npm install`。
- 通过时最后一行是 `全部 N 项通过`（写这份文件时 N = 41）。任何一项失败，脚本会抛异常、退出码非 0。
- 测试是**一个脚本从上到下顺序跑**，各项共用同一个 `env` 和数据库，前面的状态会带到后面。加测试用 `await t('说明', async () => { … })`，放在相关的那几项附近，结束前把自己加的歌删掉（参考现有用例最后的 `admin('remove', …)`）。
- 外部请求都由 `globalThis.fetch` 的替身处理；**没被模拟的网址会抛 `unexpected fetch`**。加了新的外部请求，就在替身里加对应分支。
- 常用的帮手：`req(path, init)` 请求 Worker；`hook(update)` 模拟 webhook；`admin(action, payload)` 调管理接口；`dm(uid, 文字)` 模拟私聊机器人；`lastSay()` 看机器人最后发的话；`bot.*`、`mode.*` 控制模拟服务的行为。
- 有两项保底检查，不要删也不要放宽：
  - 「播放页和管理页都能取到，内嵌脚本能通过语法检查」：取 `<script>` 和 `</script>` 之间的内容做 `new Function()`。所以两个页面**都只能有一个不带属性的 `<script>`**。
  - 「任何响应里都不出现机器人 token、管理密钥、流式服务密钥」。

### 3.2 流式服务

```bash
cd streamer
python -m venv .venv && . .venv/bin/activate        # .venv 不要提交
pip install -r requirements.txt pytest httpx
python -m pytest -q
```

- 写这份文件时是 `53 passed`（线上镜像是 Python 3.12；本地用 3.13 也能过）。
- 测试**不需要 ffmpeg**（`decode_pcm`、`convert`、`measure` 都换成了假的）；线上镜像里装了 ffmpeg。
- 可测的写法：`Streamer`、`Copier`、`Harvester`、`publish()` 都把「取消息、下载、发帖、发消息、sleep」做成参数传进去，测试传假的。新功能照这个路子写，不要在逻辑里直接用全局的 Telegram 客户端。
- 测 HTTP 接口用 `fastapi.testclient.TestClient` 配合 `monkeypatch` 替换 `app` 模块里的全局对象（参考 `test_harvest_endpoints`）。

### 3.3 提交前的检查清单

- [ ] `node test.mjs` 全过
- [ ] `cd streamer && python -m pytest -q` 全过（只改了 Worker 也要跑一下，确认没碰坏）
- [ ] 新行为有对应的测试
- [ ] `git diff` 里没有密钥、cookie、session、`.venv/`、`__pycache__/`、`.wrangler/`
- [ ] 行为变了的话，`README.md` 跟着改了；约定变了的话，本文件跟着改了
- [ ] 改了第 7 节里的任何一项，另一边也改了

---

## 4. 部署

**合进 `main` 不会自动部署。** 部署会影响线上，只在频道主明确要求时做。你的运行环境里多半没有 `CLOUDFLARE_API_TOKEN`，也连不上 Hugging Face。这时把要跑的步骤写清楚交给频道主，不要想办法绕过。

### 4.1 Worker（三选一，效果一样）

**A. GitHub Actions（推荐）**：仓库 Actions → **Deploy worker** → Run workflow。它会先跑 `node test.mjs`，不过就不部署；过了就上传 `worker.js`、`page.html`、`admin.html`，并设好两个定时任务。需要仓库 secret `CLOUDFLARE_API_TOKEN`（用「Edit Cloudflare Workers」模板建）。

**B. curl**（和 workflow 里的一样；token 从环境变量 `CLOUDFLARE_API_TOKEN` 读）：

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

# 上面不会动定时任务；要设的话（cron 字符串必须和 worker.js 的 FILL_CRON 一字不差）：
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music/schedules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '[{"cron":"0 19 * * *"},{"cron":"*/5 * * * *"}]'
```

- `keep_bindings: ["secret_text"]` 保留线上的 4 个 secret，**metadata 里不要写 secret 的值**。
- `page.html`、`admin.html` 以 `text/plain` 上传，就是文本模块（`worker.js` 里 `import PAGE from './page.html'`）。
- 迁移 `v1` 早就做过了，平时部署**不要**在 metadata 里带 `migrations`。只有新增 Durable Object 类时才要，写成 `{"old_tag":"v1","new_tag":"v2",...}`，并且同步改 `wrangler.toml`。

**C. wrangler**：在仓库根目录 `npx wrangler deploy`（需要 `CLOUDFLARE_API_TOKEN`，必要时加 `CLOUDFLARE_ACCOUNT_ID=aca35ff5f62ae4208757219dbc3b489b`）。`wrangler.toml` 里已经写好绑定、普通变量、`.html` 文本模块规则和 `[triggers] crons`，secret 不受影响。

三种方式里的 `compatibility_date`（现在是 `2026-01-01`）、绑定、普通变量要保持一致；改一处就三处一起改（`wrangler.toml`、workflow、`README.md` 里的 curl）。

部署完验证：打开 https://xiaoju-music.langhua98.workers.dev 能播放；`/api/tracks` 有数据；频道主私聊机器人发「统计」「自检」看结果；`npx wrangler tail xiaoju-music` 或 Cloudflare 控制台看日志（`fill …`、`self-check …`、`error …`）。

### 4.2 流式服务（部署在别的仓库）

流式服务和小橘视频**合用** Space `langhua1998/douyin-proxy`：视频的服务在根路径，音乐的在 Space 的 `music/` 目录，挂在 `/m` 下。

1. 改动先合进**本仓库的 `main`**。
2. 到 `langhua98/xiaoju-video` 的 Actions 跑 **Deploy streamer**。它会把视频的 `streamer/` 和本仓库 `main` 上的 `streamer/app.py`、`streamer/harvest/` 一起推到 Space，Space 自动重新构建。
3. **推之前先确认没有活在跑**：机器人里发「统计」，或者调流式服务的 `GET /harvest/status`、`GET /copy/status`，看有没有 `running`。重新构建会打断正在搬的歌、清掉审核单，视频那边正在转的作品也会断（见 6.2）。
4. Space 的 `Dockerfile`、`requirements.txt` 归**视频仓库**管。音乐要加新的 Python 依赖时，本仓库的 `streamer/requirements.txt` 和 xiaoju-video 的 `streamer/requirements.txt` **都要加**；后者在本仓库外，告诉频道主去改，或者在那边另开 PR。api-enhanced 的版本也固定在视频仓库的 `streamer/Dockerfile` 里。
5. 本仓库的 `streamer/Dockerfile` 留着，等以后音乐有了自己的 Space 再用（那时环境变量不用带 `MUSIC_` 前缀）。

### 4.3 两边都要改的时候

Worker 和流式服务没法同时上线，所以改动要**两边都向后兼容**：

- Worker 要调流式服务的新接口：先部署流式服务，再部署 Worker；或者让 Worker 在新接口回 404 / 409 时照旧能用。
- 流式服务要用 Worker 传来的新字段：字段缺了也要能跑（`body.get('x') or 默认值`）。
- 部署顺序写进 PR 描述里。

---

## 5. 线上配置

### 5.1 Cloudflare

| 项 | 值 |
|---|---|
| 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| Worker 名 | `xiaoju-music`，地址 https://xiaoju-music.langhua98.workers.dev |
| Durable Object | 绑定 `LIB`，类 `Library`（SQLite，迁移标签 `v1`），代码里用 `idFromName('library')`、`locationHint: 'apac'` |
| KV（旧） | 绑定 `TRACKS`，id `738216f3f7d64f1ab143128406d1b35e`，只在 DO 第一次启动时迁移数据用，之后不读不写 |
| 普通变量 | `CHANNEL_ID=-1003817921075`；`CHANNEL_USERNAME=xiaojumusic`（频道改私密后这个用户名已经不存在，只在管理接口里原样返回，以及「搬运频道」判断是不是正式频道时用）；`STREAMER_URL=https://langhua1998-douyin-proxy.hf.space/m`（空 = 超过 20 MB 的歌不能播放，机器人搬歌功能也全关） |
| `compatibility_date` | `2026-01-01` |

### 5.2 Worker 的 secret（值都不在仓库里，也绝不能放进来）

| 名字 | 作用 | 要换时 |
|---|---|---|
| `TG_BOT_TOKEN` | 机器人 @xiaoju_music_bot 的 token | BotFather `/revoke` 后，Worker 和 Space 的 `MUSIC_TG_BOT_TOKEN` 都要换，再确认 webhook 还在 |
| `TG_WEBHOOK_SECRET` | webhook 请求头 `X-Telegram-Bot-Api-Secret-Token` 的值 | 在 Cloudflare 里读不回来；丢了就生成新的，同时更新 Worker secret 和 Telegram 的 `setWebhook` |
| `ADMIN_KEY` | 管理页、管理接口的密钥 | 直接换 |
| `STREAMER_KEY` | Worker 调流式服务时带的 `X-Key` | Worker 和 Space 的 `MUSIC_STREAMER_KEY` 一起换 |

设置方法：`npx wrangler secret put 名字`，或者 Cloudflare API（`README.md`「日常维护」里有 curl）。

### 5.3 Hugging Face Space 的变量（Settings → Variables and secrets）

流式服务读环境变量时，`MUSIC_` 开头的会盖过同名不带前缀的（见 `app.py` 的 `settings()`），这样音乐和视频的值在同一个 Space 里互不干扰。

| 名字 | 内容 |
|---|---|
| `MUSIC_TG_BOT_TOKEN` | 和 Worker 的 `TG_BOT_TOKEN` 相同 |
| `MUSIC_STREAMER_KEY` | 和 Worker 的 `STREAMER_KEY` 相同（和视频的不是同一个） |
| `MUSIC_TG_USER_SESSION`（可选） | 频道主账号的 Telethon StringSession（由 `/login/verify` 生成）。**等于整个 Telegram 账号的登录权限**。不设就用视频那边的 `TG_USER_SESSION` |
| `MUSIC_TG_CHANNEL`（可选） | 频道 id 或用户名，默认 `-1003817921075` |
| `TG_API_ID`、`TG_API_HASH` | 两边共用，my.telegram.org 申请的 |
| `NETEASE_API`、`NETEASE_API_JS`（可选，代码里有默认值） | api-enhanced 的地址（默认 `http://127.0.0.1:3017`）和入口文件路径 |

`MUSIC_TG_BOT_TOKEN` 和 `MUSIC_STREAMER_KEY` 都设了，Space 才会挂上 `/m`。

### 5.4 定时任务

| cron（UTC） | 干什么 | 代码 |
|---|---|---|
| `*/5 * * * *` | 后台补封面、歌词（每次 8 首）；顺带自检，每小时真跑一次 | `FILL_CRON`、`fillMissing()`、`selfCheck()` |
| `0 19 * * *`（北京时间凌晨 3 点） | 叫醒流式服务 → 同步小号 → 夜里自动搬来源频道的新歌 | `nightly()` |

这几个 cron 字符串要四处一致：`worker.js` 的 `FILL_CRON`、`wrangler.toml` 的 `[triggers] crons`、`deploy-worker.yml` 里设 schedules 的那行、`README.md`。

### 5.5 Telegram

- webhook：`https://xiaoju-music.langhua98.workers.dev/tg-webhook`，`secret_token` = `TG_WEBHOOK_SECRET`，`allowed_updates=["channel_post","edited_channel_post","message","callback_query"]`（后两种是机器人私聊和按钮）。重设命令见 `README.md`「重设 webhook」。
- 设了 webhook 就不能用 `getUpdates`。**不要**调 `deleteWebhook`、`logOut`，也不要拿 `getUpdates` 调试。
- 机器人只能私聊和它说过话的人（对方先点过「开始」）。

---

## 6. 红线（每一条都有原因，改之前先读原因）

### 6.1 密钥不进仓库、不进日志、不进响应

- 密钥包括：`TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`、`STREAMER_KEY`、`CLOUDFLARE_API_TOKEN`、`TG_USER_SESSION` / `MUSIC_TG_USER_SESSION`（能登录频道主的整个 Telegram 账号）、`TG_API_HASH`、网易云 cookie（config 的 `netease`，以及流式服务内存里的 `netease_session`）。
- 仓库是公开的。示例里一律写 `<机器人 token>` 这类占位符。`wrangler.toml` 只能放普通变量。
- 不打印到日志：流式服务故意把 api-enhanced 的 stdout 丢掉（它会打出带 cookie 的请求），自检结果写日志时也不带 cookie，保持这样。Worker 的 `console.log` 只打状态，不打 cookie、token、请求头。
- 不出现在响应里：`/api/tracks` 不给 `file_id`；Bot API 的下载地址带 token，只能在服务端用，不能重定向给浏览器。`test.mjs` 最后一项专门查这个，不要削弱。
- 比较密钥用定长比较（Worker 的 `sameString()`、Python 的 `hmac.compare_digest`），不要换成 `===`。
- 如果密钥已经泄露：告诉频道主，按 `README.md`「日常维护」换掉，不要只删掉那次提交（历史里还在）。

### 6.2 Space 一重启，内存里的东西就没了

这些东西**只在流式服务的内存里**，重启、重新构建、休眠后被叫醒都会清空：

- 审核单 `Harvester.sheets`（最多 20 张）：之后频道主再按按钮，结果是 `missing`，提示「过期了，重新发一次网址」。
- 正在跑的抓取、发帖、小号同步（`Harvester`），正在跑的搬歌（`Copier`）：直接中断，排队的也没了。
- 刚扫码、还没被 Worker 取走的网易云登录 `netease_session`。
- 消息缓存、图片帖扫描缓存（丢了没关系，会重取）。

所以：

- 部署流式服务前先查有没有活在跑（4.2 第 3 步）。不要为了「试一下」去重启 Space。
- **要长期留着的状态放 Worker 的 DO 里**，由 Worker 来取或者随请求带过去。参考网易云 cookie：流式服务先留在内存，Worker 下次来 `GET /netease/session` 取走，存进 config，之后每次请求都带给流式服务。不要指望流式服务的内存，也不要让它往 Worker 推（推不过去，见第 1 节）。
- 新功能要能接受「对面刚重启过」：Worker 收到 `missing`、`409`、HTML 错误页都要给频道主一句能看懂的话，不能报错了事。
- Space 免费版闲置约 48 小时会休眠。播放大文件时 Worker 回 `503 + Retry-After`，播放页自动重试。这个流程别改坏。

### 6.3 cron 字符串必须一致

`scheduled()` 的写法是：`controller.cron === FILL_CRON` 就补封面歌词，**其他任何 cron 都当成夜里自动搬**。所以只要有一处 cron 和 `FILL_CRON` 不一样，`nightly()` 就会每 5 分钟跑一次：每次都去来源频道搬歌、同步小号。改频率时四处一起改（见 5.4），并让 `test.mjs` 里的 `tick('*/5 * * * *')` 跟着变。

### 6.4 Telegram 会话的规矩

- 流式服务的 Telethon 客户端必须是 `receive_updates=False`（`make_client()` 和 `Login` 里都是）。机器人同时挂在 Bot API 的 webhook 上，Telegram 给同一个机器人的推送可能只送到其中一个会话；这边一订阅，频道新帖就可能被抢走，Worker 就漏登记新歌。
- 不要改成自建的 `telegram-bot-api --local`，也不要对官方 Bot API 调 `logOut`（原因见 `streamer/README.md`）。
- **往频道发帖要用频道主账号（`user_client`）**。机器人收不到自己发的帖子，用机器人发的话 Worker 不会登记。
- 来源频道开了「禁止保存内容」（`ChatForwardsRestrictedError`、`noforwards`）的就跳过，**不去绕**。
- 转发用 `drop_author=True`（不带「转发自」），这是现有行为，保持。
- 遇到 `FloodWaitError` 照着等，或者停下来；不要换账号、开并发去硬抢。

### 6.5 Durable Object 和 Worker 的额度

- DO 免费版每天最多读 500 万行。`listTracks()` 把整张歌表缓存在 DO 内存里；写了 `songs` 或 `covers` 之后**必须调 `this.changed()`** 让缓存作废。不要在每次请求、每次定时任务里 `SELECT * FROM songs` / 扫 `covers`。按图找封面走索引 `covers_data`。
- 免费版 Worker 每次调用最多 50 个子请求，所以 `FILL_BATCH` 是 8、连着错 3 次就停。别把批量调大。
- Worker isolate 里的缓存（`filePaths`、`recCache`、`listCache`）随时会丢，只能当加速用，不能存必须保留的东西。
- 外部请求一律带 `AbortSignal.timeout(...)`；不用的响应体要 `res.body.cancel()`。

### 6.6 数据库结构只加不删

- 建表、加列都写在 `Library` 构造函数的 `blockConcurrencyWhile` 里，必须**可以重复执行**：`CREATE TABLE IF NOT EXISTS`；加列先查 `PRAGMA table_info(表)` 再 `ALTER TABLE … ADD COLUMN`（参考 `covers.own`）。
- 不删表、不删列、不清用户数据（歌单、手动配的歌词、收藏所依赖的消息号）。确实要做一次性数据修正时，用 config 里的版本标记（参考 `coversV`），并且写测试。
- 不要改 `[[migrations]]` 里已有的 `v1`，也不要改类名 `Library`、绑定名 `LIB`、`idFromName('library')`：改了就等于换了一个空数据库。

### 6.7 搬运的规矩

- 贴网址、爬关键词抓到的歌**必须先进审核单**，频道主点「审核通过」才发。只有频道主亲手加的「小号」主页可以不审核直接发。
- 帖子说明的格式（`授权：…`、`来源：…`）是 Worker 识别「搬来的自己的歌」的依据，不能随便改（见第 7 节）。
- 测试发帖用「搬运频道 @测试频道」，**不要拿正式频道试**。Worker 只登记正式频道的帖子。

### 6.8 会影响线上的操作，要频道主明确同意

包括：部署 Worker、跑 Deploy streamer、改 Space 的变量、`setWebhook`、调线上 `/admin/api/*`（尤其 `remove`、`playlists`、`auto-run`）、调线上流式服务的任何接口、用机器人给真人发消息、往任何频道发帖、加入或归档频道。对方同意过一次，只算那一次。

### 6.9 其他

- 不要给 Worker 加 npm 依赖或构建步骤。它现在是一个能直接上传的 ES module，`package.json` 没有任何依赖。Worker 代码里不能用 Node 专有的 API（`fs`、`Buffer` 等），只能用 Workers 运行时的 Web API。
- 页面不引外部脚本、CDN、字体，全部内联（`workers.dev` 在中国大陆本来就要 VPN，外部资源只会更慢、更容易挂）。
- 不要提交 `.venv/`、`__pycache__/`、`.pytest_cache/`、`.wrangler/`、`node_modules/`、`.dev.vars`。
- 测试不能为了变绿而删掉、跳过或者放宽。测试挂了先找原因。

---

## 7. 改一边就要改另一边

| 约定 | 位置 A | 位置 B（还有 C） |
|---|---|---|
| 整理歌名、歌手（去掉 `@频道`、「更多音乐」，拆「歌手 - 歌名」） | `worker.js` 的 `summary()` | `streamer/app.py` 的 `clean_names()` |
| 查重用的 `norm()`（只留字母、数字、汉字，转小写） | `worker.js` 的 `norm()` | `app.py` 的 `norm()`、`harvest/job.py` 的 `norm()` |
| 查重的键（整理后的歌名 + 歌手，用竖线连起来） | Worker 发给流式服务的 `existing: [[title, artist], …]`（来自 `summary()`） | `song_key()`（`app.py`、`job.py`） |
| 帖子说明格式：第一行歌名、`授权：频道主确认是小橘音乐自己的作品`、`来源：https://music.163.com/song?id=…` | `harvest/upload.py` 的 `caption()`、`OWN` | `worker.js` 的 `webhook()`（`/^授权：/m`、`/^来源：/m`）和 `neteaseIdOf()` |
| 搬运网站的 key | `harvest/sites.py` 里适配器的 `key`（现在是 `netease`） | `worker.js` 的 `HARVEST_SITES` |
| 审核单按钮数据 `hv:ok:<编号>`、`hv:no:<编号>` | `harvest/job.py` 的 `_crawl()` | `worker.js` 的 `botButton()`（`kind === 'hv'`）、`harvestDecide()` |
| 其他按钮前缀 `a`、`ap`、`r`、`rp`、`d`、`dd`、`p`、`hk`、`x` | `worker.js` 发按钮的地方 | `botButton()`。Telegram 限制 `callback_data` 最长 64 字节 |
| 审核单编号：14 位小写字母加数字 | `job.py` 的 `sheet_id()` | `worker.js` 路由的正则 `/^\/harvest-review\/([a-z0-9]{14})$/` |
| 音柱格式：`XV` + 版本 1 + 帧率 + 频段数 + 每值 4 位 | `app.py` 的 `pack_viz()` | `worker.js` 的 `viz()`（检查开头 `0x58 0x56`）、`page.html` 的解包（只认版本 1）；改格式要升版本号，DO 里存着的旧数据也得能处理 |
| 流式服务的「确定没有」是 JSON 404，「没醒」是 HTML / 5xx | `app.py` 用 `HTTPException` | `worker.js` 的 `fetchCover()`、`viz()`、`fromStreamer()` |
| `/api/tracks` 的字段 | `worker.js` 的 `summary()`、`tracksFor()`、`hotOrder()` | `page.html` |
| 拆合唱歌手（`&`、`＆`、`、`、`/`、逗号、` x `、`feat.`） | `worker.js` 的 `artistsOf()`（歌手热门歌按这个名字存） | `page.html` 的 `artistsOf()`（歌手页的名字）；对不上的话那位歌手的歌就不按热门排 |
| 管理接口 | `worker.js` 的 `adminApi()` | `admin.html`（只用 `state`、`remove`）、`README.md` 的路由表 |
| 频道主菜单 | `OWNER_COMMANDS`、`OWNER_KEYBOARD`、`OWNER_ALIAS` | 改了必须把 `COMMANDS_VERSION` 加 1，否则频道主那边的菜单不会重设 |
| 机器人说明 | `HELP`、`PUBLIC_HELP` | 加命令、改用法时同步改 |
| cron | `FILL_CRON` | `wrangler.toml`、`deploy-worker.yml`、`README.md`（见 6.3） |
| 部署参数（绑定、变量、`compatibility_date`） | `wrangler.toml` | `deploy-worker.yml`、`README.md` 的 curl |
| Python 依赖 | `streamer/requirements.txt` | `langhua98/xiaoju-video` 的 `streamer/requirements.txt`（线上真正用的） |
| 行为说明 | 代码 | `README.md`（频道主的手册）；改了约定再加上本文件 |

---

## 8. 写法和风格（照着现有代码写）

### 8.1 通用

- **用户看到的文字全是中文**：网页、机器人回复、错误提示、`README.md`。口语、简短、说人话，像现有的「搬运服务正在唤醒，过一两分钟再发一次」。告诉对方接下来该怎么做，不要甩技术细节。
- **代码注释用中文，写「为什么」**：现有注释大多在讲原因和踩过的坑（比如为什么 `receive_updates=False`、为什么不扫全表）。改代码时别删这类注释；改了行为就把注释一起改对。
- 代码里的标识符用英文，跟周围已有的命名走（`ownerHarvest`、`fillMissing`、`start_direct`）。
- 外部服务出错时，**只存「确定的结果」**：确定没有封面、歌词才存 `none`；只是这次出错（超时、5xx、对面在睡）就回 `503 + Retry-After`，什么也不存，下次再试。现有的封面、歌词、音柱都是这个规矩。

### 8.2 Worker（`worker.js`）

- 2 空格缩进、单引号、带分号；`async function` 写在模块顶层；不引第三方库。
- 要返回错误状态码就 `throw new HttpError(状态码, '中文说明', 额外响应头)`，由 `fetch` 统一转成响应。没预料到的异常会记日志并回 500，不要把异常吞掉不管。
- 公开接口用 `text()` / 带 `cors()` 的响应；管理接口用 `json()`（故意不带 CORS 头）。
- 读数据一律通过 `lib(env)` 调 `Library` 的方法；`Library` 里的方法中间别插 `await` 外部请求，免得几条 SQL 之间被别的请求插进来。
- 机器人的慢活（调流式服务、搜歌）放在 webhook 先回 200 之后的 `ctx.waitUntil` 里，现有结构已经这样，加新命令照着放进 `botUpdate()`。
- 调流式服务用 `streamerCall(env, path, body)`（自带 `X-Key` 和超时）；先判断 `streamerOn(env)`。
- 改了歌、封面、歌单之后：DO 里调 `changed()`，Worker 里调 `forget(id)` 或者 `listCache = null`。

### 8.3 页面（`page.html`、`admin.html`）

- 单文件：CSS、JS、图标（base64）全部内联。**只能有一个 `<script>`，不带属性**（测试按这个切出脚本做语法检查）。
- 手机优先：iPhone Safari 是主力。音频必须走 `<audio>` 加 Range；音柱用 `/v/` 的预计算数据画，**不要接 Web Audio 实时分析**（iPhone 锁屏、切后台会没声音）。
- 播放页是固定的深色设计（不跟随系统）；管理页跟随系统深浅色（`prefers-color-scheme`）。改样式时保持各自的做法。
- localStorage 键名 `xm-favs`、`xm-prefs`、`xm-recent` 不改；读写包在 try/catch 里（隐私模式、被清空时会出错）。
- 改完至少跑 `node test.mjs`（会做语法检查）；样式、交互的改动请频道主部署后在手机上看一眼。

### 8.4 流式服务（`streamer/`）

- 4 空格缩进、单引号；接口都是 `async def`；每个接口第一行 `check_key(request)`（`/` 除外）。
- 请求体字段一律做类型转换和范围限制（参考 `max(1, min(int(body.get('limit', 50)), 2000))`），频道名用 `\w{4,64}` 校验。
- 长任务用 `asyncio.create_task` 在后台跑，接口马上返回；做完由 `bot_say()` 私聊频道主。一次只跑一单，忙的时候回 `409` 带 `{busy: 说明}`。
- 必须宽泛地 `except Exception` 时加 `# noqa: BLE001 — 原因`，并且 `log.exception(...)` 或把原因写进结果。
- 网易云一律经 api-enhanced（`NetEase._get()`），不要在 `harvest/` 里自己拼网易云的加密接口。
- 下载用 `Http`（带 UA、限速、重试），不要在 `harvest/` 里直接 `urllib`。
- 依赖注入：新逻辑写成类或函数，把 Telegram、网络、ffmpeg、sleep 作为参数传进来，方便测试。

---

## 9. 常见任务怎么做

**加一个机器人命令（频道主用）**
1. 在 `botUpdate()` 的 `if (isOwner) { … }` 里加匹配，注意顺序：网址匹配 `/(https?:\/\/\S+)/` 很宽，具体命令放它前面。
2. 写处理函数，回复用 `say()`；要调流式服务就先 `streamerOn(env)`，失败时回「正在唤醒，过一两分钟再……」。
3. 改 `HELP`。要放进菜单的话，改 `OWNER_COMMANDS`、`OWNER_ALIAS`，**`COMMANDS_VERSION` 加 1**。
4. 在 `test.mjs` 里用 `dm(OWNER, '命令')` 加测试，`lastSay()` 检查回复。
5. 在 `README.md`「机器人和自动搬歌」里补一句。

**加一个 Worker 路由或管理接口**
1. 公开路由加在 `fetch` 里，写在 `return text('Not Found', 404)` 之前；管理接口加在 `adminApi()` 里。
2. 参数严格校验，不对就回 400（`json({ error: '参数不对' }, 400)`）。
3. 加测试；如果响应里可能带上用户数据，确认没有密钥、`file_id`。
4. 更新 `README.md` 的路由表和本文件 2.2。

**加一张表或一列**：见 6.6。写在 `Library` 构造函数里，可以重复执行；`Library` 里加读写方法；测试里用 `makeLibrary()` 重新建库，验证老数据能升级（参考「切片那一版的数据库」那个用例）。

**加一个搬运网站**
1. 在 `streamer/harvest/sites.py` 写适配器类：`key`、`name`、`match(url)`、`items(url, limit, http)`（异步生成器，给出 `Track`）；能按关键词搜的加 `search(query, limit, http)`；下载地址要现取的加 `download(track, http, cookie)`；能判断网址类型的加 `describe(url, http)`；有主页热门歌的加 `hot(url, http)`。
2. 放进 `ADAPTERS`。
3. Worker 的 `HARVEST_SITES` 加 `{key: '显示名'}`。
4. `test_harvest.py` 用假的 `Http` 写测试（参考 `test_netease_*`）。

**改流式服务的接口**：两边一起改、一起测，保证向后兼容（4.3）；PR 描述写清楚先部署哪边。

**改定时任务的频率或时间**：四处一起改（6.3），`test.mjs` 里的 `tick(...)` 也改；部署时 workflow 会重设 schedules，用 curl 部署的要单独设。

**改歌名整理、查重规则**：`summary()` 和 `clean_names()` 一起改，`norm()` 三处保持一致；两套测试都加用例。

**改自动分歌单**：只改 `GENRE_ARTISTS`、`GENRE_WORDS`、`NOT_A_SONG`、`genresOf()`；注意只会放进**已经存在**的同名歌单。新歌单由频道主建：机器人发「搬运歌单 名字」（没有就新建），或者调 `POST /admin/api/playlists`（整体替换，要把现有歌单连同 `id` 一起传回去，没列出的会被删掉）。

---

## 10. 线上出问题怎么查

能用的工具：Worker 日志（`npx wrangler tail xiaoju-music` 或 Cloudflare 控制台）、Space 的 Logs 页、机器人的「统计」「自检」「搬运设置」、管理页。这些都要频道主授权或者由频道主来看。

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| 大文件提示「正在唤醒」 | Space 在休眠或重新构建 | 等 1～2 分钟，播放页会自己重试；一直不好就看 Space 日志 |
| 机器人回「搬运服务正在唤醒」 | 同上 | 过一两分钟再发 |
| 新发的歌不进歌单 | webhook 丢了，或者被查重挡掉（同名同歌手、时长差 3 秒内） | 用 `getWebhookInfo` 看 webhook；查重属于正常行为 |
| 网页、接口回 500「服务器出错了」 | 多半是 DO 额度用完，或者代码异常 | 看 Worker 日志里的 `error` 行；额度问题查最近有没有加了全表扫描 |
| 审核单按钮提示「过期了」 | 流式服务重启过，审核单丢了 | 让频道主重新发一次网址 |
| VIP 歌「只给试听片段」「不给下载」 | 网易云没登录，或者会员过期 | 频道主发「网易云登录」扫码；会员在 App 里续 |
| 「自检」里频道发不了帖 | 频道主账号的 session 失效，或者不是频道管理员 | 重新 `/login/code`、`/login/verify`，把新 session 存进 Space 的 `MUSIC_TG_USER_SESSION` |
| 封面全是同一张图 | 别的频道的台标被当成了封面 | 正常会自动识别（8 首共用就算台标）；手动处理调 `POST /admin/api/ban-cover`（`{track}`，管理页上没有按钮） |
| 夜里自动搬没动静 | Space 没叫醒、上一轮还在跑，或者来源名单是空的 | `GET /admin/api/auto-state` 看记录；`POST /admin/api/auto-run` 手动跑（要频道主同意） |

---

## 11. Git 和 PR

- 从 `main` 拉分支改，不要直接推 `main`，除非频道主明确要求。
- 一个 PR 只做一件事。行为变了的，`README.md` 在同一个 PR 里一起改。
- 提交信息沿用仓库现有风格：**英文**，一行说清改了什么，可以带模块前缀，比如 `Harvest: report the actual error when a song fails to post`、`Streamer: find the music channel by id, it is private now`、`Background fill: every 5 minutes, read only the next 8 songs`。
- PR 描述写：改了什么、为什么、怎么测的（两套测试的结果）、要不要部署、先部署哪边、部署前要注意什么（比如「推流式服务前先确认没在搬歌」）。
- 提交信息、PR 描述里不写密钥、cookie、内部地址以外的敏感信息。
