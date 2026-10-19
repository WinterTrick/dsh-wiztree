# dsh-wiztree

让 DeepSeek Harness 智能体调用 [WizTree](https://diskanalyzer.com/) 的**命令行 CSV 导出**能力，秒级建立磁盘/文件夹索引，然后按需查询——无需让模型递归遍历文件系统。

> 实测：C 盘全盘（53 万文件 / 140 GB）扫描 **7.8 秒**，之后所有查询都在缓存的索引上进行。

## 工具

| 工具 | 作用 |
| --- | --- |
| `wiztree_scan` | 用 WizTree 扫描指定盘符或文件夹，生成索引（CSV），返回最大的文件夹、最大的文件、按扩展名统计的占用 |
| `wiztree_query` | 在已缓存的索引上查询：`list` 列目录、`find` 按名字/大小/扩展名找文件、`top` 找最大文件、`types` 按类型统计、`info` 查看索引信息 |

## 安装

需要 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2.1 或更新版本，以及本机安装的 WizTree（默认路径 `G:\Wiztree\WizTree64.exe`）。

### 从 GitHub 安装

```sh
dsh plugin --profile desktop add https://github.com/WinterTrick/dsh-wiztree
```

或：

```
plugin_manager { action: "install_bundle", target: "https://github.com/WinterTrick/dsh-wiztree" }
```

### 从 GitHub Release 安装

```sh
# 始终指向最新 Release 的固定文件名（推荐）
dsh plugin --profile desktop add https://github.com/WinterTrick/dsh-wiztree/releases/latest/download/dsh-wiztree.tgz

# 或钉住某个版本
dsh plugin --profile desktop add https://github.com/WinterTrick/dsh-wiztree/releases/download/v1.0.0/dsh-wiztree-1.0.0.tgz
```

### 从本地目录安装（开发调试）

```
plugin_manager { action: "install_bundle", target: "D:\\path\\to\\dsh-wiztree" }
```

安装后无需重启，工具会直接出现在会话中。

## 提权说明（重要）

WizTree 通常在 Windows 兼容性设置里被标记为 `RUNASADMIN`，也就是**普通进程直接启动它会被拒绝**（`EACCES` / 错误 740）。插件按以下顺序处理：

1. **DSH 以管理员身份运行** → 直接启动，无 UAC 弹窗，且启用 WizTree 的 MFT 快速扫描。推荐。
2. **DSH 普通权限运行**（`elevation: auto`，默认）→ 先尝试直连；被拒后通过 `Start-Process -Verb RunAs` 拉起 UAC。用户点一次「是」后，WizTree 以管理员权限运行，同样可用 MFT 扫描。每次扫描都需要确认一次。
3. `elevation: never` → 不弹 UAC，直接启动；在 `RUNASADMIN` 标记下通常会失败并给出提示。

想完全免弹窗，请以管理员身份重启 DSH。也可以手动取消 WizTree 的「以管理员身份运行此程序」兼容性勾选，此后插件走标准扫描（无需提权，但全盘较慢）。

### 签名校验

在启动（尤其提权启动）之前，插件会用 Windows Authenticode 校验 `executable`：签名状态必须为有效，且签发者主题包含 `signaturePublisher`（默认 `Antibody Software`）。这能防止安装目录里的 WizTree 被替换后，插件仍把它当作 WizTree 以管理员权限运行。校验结果按文件大小 + 修改时间缓存，文件被替换后会重新校验。

如果你使用的是未签名或别的发布者签名的 WizTree 构建，设置 `verifySignature: false`，或把 `signaturePublisher` 改成实际签发者。

## 配置

配置位于 `cordis.patch.yml` 的 `wiztree` 行，可在用户自己的 patch 层覆盖：

```yaml
- id: wiztree
  name: dsh-wiztree
  config:
    executable: 'G:\Wiztree\WizTree64.exe'
    elevation: auto
    admin: true
    verifySignature: true
    signaturePublisher: Antibody Software
    allowRoots: []
    denyRoots: []
    timeoutMs: 300000
    maxScans: 8
    defaultLimit: 50
    maxExportDepth: 0
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `executable` | `G:\Wiztree\WizTree64.exe` | WizTree 可执行文件。请用 64 位版本：32 位 `WizTree.exe` 只是转交给 64 位进程后立即返回。 |
| `elevation` | `auto` | `auto`：直接启动被拒时用 UAC 重试；`uac`：非提权时总是走 UAC；`never`：从不提权。 |
| `admin` | `true` | 请求 WizTree 的 MFT 快速扫描（仅在实际以管理员权限运行时生效）。 |
| `verifySignature` | `true` | 启动前校验 WizTree 的 Authenticode 签名（状态有效 + 签发者匹配），防止被替换的程序被提权运行。 |
| `signaturePublisher` | `Antibody Software` | 签名者主题必须包含的字符串，大小写不敏感。 |
| `allowRoots` | `[]` | 非空时，只允许扫描这些盘符/目录（例如 `["D:\\"]`）。 |
| `denyRoots` | `[]` | 拒绝扫描这些盘符/目录及其子目录（例如 `["C:\\Windows\\"]`）。只检查扫描根，见下方说明。 |
| `timeoutMs` | `300000` | 单次扫描（含等待 CSV 写入完成）的超时，毫秒。 |
| `maxScans` | `8` | 同时保留的索引数，超出后最旧的索引及其 CSV 会被删除。 |
| `defaultLimit` | `50` | 查询默认返回条数（最大 500）。 |
| `maxExportDepth` | `0` | WizTree `/exportmaxdepth`，0 表示不限制。 |
| `cacheDir` | `<系统临时目录>\dsh-wiztree` | 索引 CSV 的存放目录（绝对路径）。 |
| `extraArgs` | `[]` | 追加到每次扫描命令行的原始参数。 |

## 使用

```
wiztree_scan   { "path": "C:" }
wiztree_query  { "action": "list", "path": "C:\\Users\\Public" }
wiztree_query  { "action": "find", "pattern": "*.mp4", "minSize": "100mb" }
wiztree_query  { "action": "types", "limit": 15 }
wiztree_query  { "action": "info" }
```

## 开发

纯 ESM，无依赖、无构建步骤。Node.js 22.19+。

```sh
npm run check      # 校验清单、补丁、JS 语法、locale/icon、files 列表
npm pack           # 生成 dsh-wiztree-<version>.tgz（prepack 会再跑一次 check）
npm pack --dry-run # 只看将要打包的文件
```

项目结构：

- `index.js` — Host 插件入口，注册工具
- `src/config.js` — 配置校验与默认值
- `src/runner.js` — 调用 WizTree（直连 / UAC 提权）、等待 CSV 完成、超时/取消
- `src/csv.js` — WizTree CSV 流式解析（UTF-8 / GBK）
- `src/store.js` — 索引缓存与 CSV 生命周期
- `src/tools.js` — 两个工具的定义、统计与格式化
- `src/format.js` — 大小/路径/glob 辅助
- `scripts/check.mjs` — 发布前校验
- `locale/*.json`、`icon.svg` — Plugin Manager 中显示的标题、描述与图标

## 安全与隐私

- **提权行为**：Windows 上 WizTree 常被标记为 `RUNASADMIN`，插件会通过 UAC 以管理员权限启动它。启动前会校验 Authenticode 签名（状态有效 + 签发者匹配 `signaturePublisher`），因此安装目录里的可执行文件被替换时会被拒绝，而不是被提权执行。仍建议把 WizTree 安装在只有管理员可写的目录。
- **扫描范围**：`path` 由模型提供。如果你只想让插件扫描特定位置，配置 `allowRoots`（白名单，非空时只允许这些根）；`denyRoots` 只能拒绝「扫描根本身位于其下」的请求，不能阻止通过父目录间接包含子目录。
- **扫描结果会离开本机**：索引摘要和查询结果会作为工具结果发送给所配置的模型服务，其中包含文件路径、文件名和大小。不要让模型扫描你不想上传的目录；配合 `allowRoots`/`denyRoots` 可以限制范围。
- **缓存目录**：`cacheDir` 中的 CSV 由提权进程写入。插件会拒绝符号链接/junction 形式的缓存目录，也只会删除自己命名的 `wiz-*.csv`；建议保持默认（用户临时目录）或指向仅当前用户可写的目录。
- **工具参数**：`path`/`filter`/`exclude` 来自模型，插件已按 Windows `CommandLineToArgvW` 规则精确转义，无法借此注入额外的 WizTree 开关；`extraArgs` 属于受信配置，只应填写你信任的参数。
- **第三方程序**：插件本身没有运行时依赖、不发起网络请求、不读取凭据；磁盘数据全部来自 WizTree 的 CSV 导出。

## 限制

- 仅 Windows。
- 扫描时 WizTree 窗口会短暂出现；写出 CSV 后自动退出。UAC 模式下一次扫描需要点一次确认。
- 索引保存在 Host 进程内存中，DSH 重启后需要重新扫描；CSV 文件在缓存目录中最多保留一天。

## License

[MIT](LICENSE)
