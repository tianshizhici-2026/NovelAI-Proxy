# NovelAI Proxy

支持文生图、图生图和局部重绘的 NovelAI 工作台，提供多账号、额度管理和移动端操作。

## 快速开始

需要 Node.js 24.5 或更新版本，以及可用的 NovelAI Opus 账号和 API Key。

```bash
git clone https://github.com/tianshizhici-2026/NovelAI-Proxy.git
cd NovelAI-Proxy
npm ci
cp .env.example .env
npm run setup
npm run build
npm start
```

`npm run setup` 会提示创建管理员账号。访问 `http://localhost:6006`，登录后从顶部进入「账号管理」，在「API Key」页添加 NovelAI API Key，再创建普通账号。

开发运行使用 `npm run dev`，同样访问 6006 端口。

## 账号管理

- 账号列表：查看账号、剩余额度和累计用量。
- 账号详情：调整额度、补满额度、临时封禁或解封。
- 新增 / 编辑：设置账号名、密码、角色和额度；普通账号默认 50 张。
- 删除：需确认，不能删除当前登录账号，至少保留一名管理员。
- 修改账号名、密码或角色后，该账号需要重新登录；有生成或排队任务时需等待任务完成。

成功生成一张图片扣除一张额度，失败不扣。补满额度清零本轮用量，保留累计用量。管理员不受本地额度限制。

## API Key

管理员在「API Key」页添加或更换 Key，验证成功后立即生效。所有账号共用同一个 Key；界面只显示末四位。也可通过 `.env` 的 `NOVELAI_TOKEN` 配置，管理页保存的 Key 优先。

生成要求有效的 Opus 订阅及足够的 V5 额度。默认低于 1% 时停止生成；同一 Key 在其他客户端使用时，也会消耗上游额度。

## 图像创作

- **文生图**：填写场景、负面和角色提示词；人物位置默认由 AI 决定，也可自定义。
- **图生图**：上传参考图，直接调节 Strength（0.01–1）和 Noise（0–1），默认分别为 0.55、0.2。导入参考图时自动读取可用的 NovelAI 元数据。
- **局部重绘**：上传底图或点击结果中的「继续重绘」，涂抹需要修改的区域。Strength 独立保存；从文生图或图生图开始重绘时设为 0.55。
- **蒙版**：支持画笔、橡皮、矩形、撤销、重做、反选和透明度。
- **Seed**：绘图设置中可选择随机或固定（0–4294967295），默认每次随机。导入元数据会带入原图 Seed 并切换为固定；可手动切回随机。
- **元数据**：三种模式的结果均带生成参数和实际 Seed，可重新导入。
- **历史**：可复用提示词、继续重绘、用作参考图，或导出全部图片与参数 ZIP。图片可长按或使用浏览器图片菜单保存。

图片支持双指或滚轮缩放、拖动查看、双击复位。手机端上滑提示词面板可全屏展开，下拖顶部可收起。生成期间可以编辑下一张的提示词。

默认模型为 V5 Full，重绘使用对应 Inpainting 模型。提供 832×1216、1216×832、1024×1024 三种尺寸，Steps 为 23–28，Guidance 为 0.1–10，每次生成一张。全站同时执行一个生成任务，最多另有五张排队。

## 配置与数据

复制 `.env.example` 后可按需设置：

| 配置 | 默认值 / 用途 |
| --- | --- |
| `PORT` / `HOST` | `6006` / `0.0.0.0` |
| `PUBLIC_ORIGIN` | 外部访问地址，如 `https://images.example.com` |
| `NOVELAI_TOKEN` | 可选，环境变量中的 API Key |
| `NOVELAI_IMAGE_URL` | `https://image.novelai.net` |
| `NOVELAI_MIN_USAGE_PERCENT` | `1`，最低可用额度百分比 |
| `ACCOUNTS_FILE` | `data/accounts.json`，账号与用量 |
| `SETTINGS_FILE` | `data/settings.json`，管理页保存的 API Key |
| `NOVELAI_PRICE_URL` | 可选价格查询地址；配置后只接受返回 `price: 0` 或 `cost: 0` 的请求 |

账号密码和 API Key 明文保存在服务端数据文件中，文件权限为 `0600`。请备份并限制 `data/` 的访问；`.env`、数据、日志和生成产物均已加入 Git 忽略规则。

图片历史与提示词草稿保存在当前浏览器，普通用户按账号区分；改名不会迁移原账号的浏览器历史。清除站点数据会删除本地历史。服务器不保存生成图片，重启服务后需重新登录。

使用 Nginx 等反向代理时设置 `PUBLIC_ORIGIN`，建议启用 HTTPS，并将读取超时设为至少 `1200s`，以支持排队。

## Docker

```bash
docker build -t novelai-proxy .
mkdir -p data
docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD/data:/app/data" novelai-proxy npm run setup
docker run -d --name novelai-proxy --restart unless-stopped \
  --user "$(id -u):$(id -g)" --env-file .env \
  -v "$PWD/data:/app/data" -p 6006:6006 novelai-proxy
```

`data/` 需对容器运行用户可写，并在更新容器时保留。

## 检查

```bash
npm test
npm run build
```

本项目为独立的第三方工作台，与 NovelAI 官方无隶属关系。许可证见 [LICENSE](LICENSE)。
