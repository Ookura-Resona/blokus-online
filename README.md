# 角斗士棋 · 多人在线（Blokus Online）

![棋盘](art/board.png)

四人联机的 Blokus（角斗士棋）。房主建个房间，把链接甩进群，朋友用手机浏览器点开就能进房间开打。
支持**四人混战**、**二对二**、**AI 补位**。

- 后端：Node 内置 `http` + 手写 RFC 6455 WebSocket
- 前端：原生 ES Module + Canvas，没有构建步骤
- **运行时零依赖** —— `dependencies` 是空的，`node server/index.js` 直接就能跑
- 也可以部署到 Cloudflare Workers + Durable Objects（免费、不休眠）

```
21 块棋子 / 89 格 / 91 种朝向    20×20 棋盘    4 个起始角    逆时针轮转
```

---

## 快速开始

```bash
npm start          # 等同于 node server/index.js
```

终端会打印可以访问的地址：

```
  本机访问：   http://localhost:3000/
  局域网访问： http://192.168.1.23:3000/    ← 手机连同一个 WiFi 用这个
```

换端口或监听地址：

```bash
PORT=8080 node server/index.js
HOST=127.0.0.1 PORT=8080 node server/index.js
```

房号是 4 位。建好房间后点「分享邀请链接」，得到的是 `https://你的地址/?r=A7KQ` ——
**别人点开就自动进这个房间**。HTTPS 下会调起手机系统分享面板，可以直接发微信群。

---

## 部署上线

### 方式一：Cloudflare Workers（推荐）

不依赖你的电脑、免费、不休眠、不用绑卡。

```bash
cd Blokus
npm install            # 只装 wrangler 这个开发工具，运行时不装任何东西
npx wrangler login     # 浏览器里点一下授权
npm run worker:deploy  # 自检 → 生成静态资源 → 部署
```

部署完会打印 `https://blokus-online.<你的子域>.workers.dev`。

> ⚠️ **`*.workers.dev` 在中国大陆打不开**，需要绑一个自己的域名。
> 在域名已加入 Cloudflare 且状态为 Active 之后，改一下
> [wrangler.toml](wrangler.toml) 里的 `routes` 再部署一次即可，代码不用动。

本地调试：`npm run worker:dev` → http://127.0.0.1:8787

### 方式二：自己的服务器

```bash
docker compose up -d          # 游戏 + Caddy（自动 HTTPS 和 WebSocket 转发）
```

或者用 `deploy/vps-setup.sh` 装成 systemd 常驻服务，用 `deploy/Caddyfile` 做反代。

### 部署完先自检

别急着把链接发出去，先确认真能连：

```bash
node tools/check-deploy.js https://你的地址
```

会真实走一遍：静态资源 → 分配房号 → WSS 升级 → 建房/加入/开局 → 落子 → 双端棋盘一致性。

---

## 玩法规则

1. **四位玩家各执一色，按逆时针顺序轮流下棋。**
   座位顺序（屏幕上的逆时针）：左上蓝 → 左下黄 → 右下红 → 右上绿。

2. **每人第一枚棋子必须盖住自己那一角的起始点。**

3. **之后每一枚新棋子，至少要有一个角与自己的棋子角对角相接；
   同一颜色的棋子之间不能边边相邻。与其他颜色没有任何接触限制**（可以随便贴着别人下）。

4. **轮到某位玩家却无处可下时，他当轮弃权**；当所有还能下棋的玩家都下不动时，本局结束。
   已经把手上的牌下完的玩家自动退场，剩下的人可以继续单独下完。

**棋子**：标准 Blokus 全套 21 枚、共 89 格（1 格 ×1、2 格 ×1、3 格 ×2、4 格 ×5、5 格 ×12）。
棋子是双面的，所以界面上「旋转」和「翻转」是两个不同的按钮。

### 计分

**四人混战** —— 按占格数排名，最多者胜：

| 名次 | 第 1 名 | 第 2 名 | 第 3 名 | 第 4 名 |
|---|---|---|---|---|
| 增减分 | **+3** | **+1** | **0** | **−2** |

- 占格数相同时，**后手（座位号更大）排名更高**
- **统治力奖励**：头名领先第二名达到阈值，额外 +1
- **全清奖励**：头名把 21 块全部下完，额外 +1
- 两项可叠加

**二对二** —— 对角的两人为一队（左上蓝 + 右下红 vs 左下黄 + 右上绿）：

- 占格总数多的一队获胜；总数相同时，**后手的一队获胜**
- 胜方每人 **+2**，败方每人 **−1**
- 领先达标或全清的胜方玩家额外加分

积分在房间里**跨局累加**，大厅能看到排行榜。

---

## 调整积分规则

在项目根目录放一个 `blokus.config.json`（参考 `blokus.config.example.json`），启动时自动读取：

```json
{
  "port": 3000,
  "aiDelayMs": 650,
  "offlineTakeoverMs": 30000,
  "scoring": {
    "base": 1,
    "ffaRankDelta": [3, 1, 0, -2],
    "teamWinDelta": 2,
    "teamLoseDelta": -1,
    "domination": { "enabled": true, "ffaGap": 10, "teamGap": 20, "points": 1 },
    "fullClear":  { "enabled": true, "points": 1 }
  }
}
```

`ffaGap` / `teamGap` 是统治力奖励的领先格数阈值。改完重启即可生效，也可以直接跑
`node tools/sim.js 60 normal ffa` 用自对局模拟器看效果。

---

## 界面上怎么操作

**大厅**

- 点空座位坐下 —— **座位决定你的颜色和出牌顺序**：左上蓝（先手）→ 左下黄 → 右下红 → 右上绿。
  再点一次自己的座位可以起身。
- 房主可以：点 AI 座位把它收回成空位、切模式、切 AI 难度、点「开始游戏」。
- **人数不满也能开局，空位自动补成 AI。**

**对局**

- 顶部的玩家条显示四个人各自的**在线 / 离线 / 重连中**状态，轮到谁会有高亮。
- 点棋子选中，再点棋盘落子；能放的位置会高亮，放不下的棋子会灰显。
- 拖动平移棋盘，双指缩放；点「旋转」/「翻转」切换朝向。
- 轮到你时有倒计时提示，超时会自动托管，不会卡住整桌人。

---

## 项目结构

```
Blokus/
├─ server/           Node 自托管后端
│  ├─ index.js       启动入口（读配置、监听端口、打印局域网地址）
│  ├─ app.js         HTTP + WebSocket 应用工厂（静态托管、路由、心跳）
│  ├─ ws.js          手写的 RFC 6455 WebSocket 服务端
│  └─ config.js      读取 blokus.config.json 与环境变量
├─ worker/           Cloudflare Workers 后端
│  ├─ index.js       Worker 入口：/ws 路由到 DO、/api/new-room 分配房号、其余静态资源
│  └─ room.js        房间 Durable Object（WebSocket 包装、状态持久化）
├─ shared/           ★ 服务端与浏览器共用同一份
│  ├─ constants.js   棋盘规格、座位/颜色、阵营划分、默认积分
│  ├─ pieces.js      21 枚棋子 + 全部旋转/翻转朝向 + 镜像映射
│  ├─ rules.js       落子合法性、轮转、弃权、终局、序列化
│  ├─ scoring.js     混战/二对二排名、后手优先、统治力与全清奖励
│  ├─ ai.js          合法着法枚举 + 启发式评分 + 一层前瞻
│  ├─ rooms.js       房间/座位/对局流程（无 node: 依赖，两套后端共用）
│  └─ protocol.js    客户端↔服务端消息类型
├─ public/
│  ├─ index.html     三个界面：首页 / 房间大厅 / 对局
│  ├─ style.css      移动优先的深色样式
│  ├─ board.js       Canvas 棋盘渲染 + 触屏交互
│  └─ app.js         连接、大厅、对局 UI 与消息处理
├─ test/             测试（见下）
├─ tools/            自检、模拟器、静态资源构建等脚本
├─ deploy/           VPS 部署（systemd 单元 + Caddy 反代 + 一键脚本）
├─ Dockerfile / docker-compose.yml / wrangler.toml
└─ blokus.config.example.json
```

浏览器直接加载 `/shared/*.js`，所以**同一份规则引擎**既在服务端做权威校验，
也在前端做本地预演（高亮能放的位置、灰显放不下的棋子），两边不会出现规则不一致。

---

## 测试

```bash
npm test          # 116 个测试
npm run check     # 语法 / 编码 / 站内路径大小写 / 端到端冒烟
```

覆盖了棋子形状与朝向、合法性判定、计分与排名、配置文件、WebSocket 协议（含 RFC 6455 官方向量）、
房间流程，以及**加载真实页面、只用点击 UI 打完一整局**的前端 e2e。
`test/worker.test.js` 需要本地有跑着的 Worker，没有时会自动跳过。

```bash
npm run worker:dev                                       # 一个终端
BLOKUS_TARGET=http://127.0.0.1:8787 npm run test:inproc  # 另一个终端
```

---

## 常见问题

**手机打不开 `http://192.168.x.x:3000/`？**
确认手机和电脑在同一个 WiFi（不是流量）；Windows 防火墙放行 Node 的入站连接。

**`wrangler` 报 `Could not detect a directory containing static files`？**
多半是没在项目根目录执行。先在终端里 `cd` 到有 `wrangler.toml` 的那一层：

```bash
npm run worker:preflight   # 会明确告诉你当前目录对不对
npm run worker:deploy
```

**「分享邀请链接」点了没反应？**
HTTP 下浏览器禁用 `navigator.share` / `navigator.clipboard`，程序会降级成手动复制。
用 HTTPS 就能用原生分享面板。

**服务器重启后房间没了？**
房间和对局状态存内存里，重启即清空。（部署到 Cloudflare Workers 时状态会持久化到 Durable Object。）

**能加多少人？**
每个房间固定 4 个座位（Blokus 的规则），但**旁观者不限**，能看到实时棋盘和聊天。

---

## 许可

MIT
