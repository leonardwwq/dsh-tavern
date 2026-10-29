# 开发、验证与恢复

[返回首页](<../README.md>) · [剧本格式](<adventure-format.md>) · [NPC 自主性](<npc-autonomy.md>)

## 环境与依赖装载

需要 Node.js 22+、DSH Web、默认模型和 `spawn` 服务；以 DSH 0.2.1-rc.2 公开接口实现。tavern 声明 `dsh-cultivation: ^0.4.1`，所需角色能力最低版本为 0.4.1；cultivation 可以独立使用，不反向依赖 tavern。

[装载配置](<../cordis.patch.yml>)提供 cultivation 兜底启动，因为 npm 依赖不等于插件启用。在同一标准装载组已配置 cultivation 时让位，避免重复启动；判定使用当前 DSH Loader 的 `!!js` 机制，已覆盖真实 Loader 和嵌套依赖解析测试。复杂嵌套装载组或表达式禁用行不在首期自动去重保证范围内。若宿主仍解析到旧服务，会明确报告依赖接口错误，不会迁移日常角色来掩盖问题。

新增 bundle 后重启原 DSH 进程，刷新原 Web 地址。客户端是直接可加载模块，不需要替代 Web 服务；仅修改源码不代表自动热更新。

## 正常开发

当所需 cultivation 版本已发布到 npm 后，在项目根目录安装即可：

```sh
npm install --cache .npm-cache
npm test
npm run check
npm run build:demo
```

### 使用本地 sibling cultivation

需要开发尚未发布的 cultivation 修改时，可将两个仓库并列放置。以下本地安装方式可能产生开发符号链接，因此**不能直接从这个开发目录打包发布**：

```sh
npm install --cache .npm-cache --no-save --package-lock=false --ignore-scripts --no-audit --no-fund ../dsh-cultivation fflate@^0.8.2 yaml@^2.8.1
npm test
npm run check

# 只打印计划，零安装副作用
node scripts/install-local.mjs

# 在 staging 中安装真实 cultivation tarball，再生成最终包
node scripts/install-local.mjs --pack-only

# 可选：显式选定 profile，打包并使用原生 CLI 安装；不另起服务
node scripts/install-local.mjs --execute --profile web
```

[本地打包器](<../scripts/install-local.mjs>)默认使用相邻 cultivation 仓库，也可通过 `--cultivation-dir /absolute/path/to/dsh-cultivation` 指定。它校验 cultivation 版本、构建示例，在本地 staging 打包 cultivation，将真实 tarball 安装到 staged tavern，再生成最终归档，不改正式依赖声明、源码依赖链接或锁文件。默认计划模式不改文件、profile 或正在运行的 GUI；安装必须显式 `--execute --profile NAME`。

### 审核归档后再发布

npm 会跳过被 bundle 的符号链接依赖。不要用开发目录直接执行 `npm publish`，也不要把在链接状态下直接 `npm pack` 的结果当作完整发布包。使用上述 helper 生成真实包含 cultivation 的归档，审核后只发布**审核过的同一个 tarball**：

```sh
node scripts/install-local.mjs --pack-only
npm pack --dry-run --json ./dist/dsh-tavern-adventure-0.2.0.tgz
npm publish ./dist/dsh-tavern-adventure-0.2.0.tgz --access public
```

归档审核应确认版本、文档、示例、许可与真实 bundled cultivation 都齐全，并执行发布方自己的验证流程。helper 本身不执行 npm 发布、Git 提交/推送或服务重启。上面的 publish 是维护者的显式发布步骤，不是普通玩家安装步骤。

审核包也可以交给 DSH 原生 CLI 安装：

```sh
npx @deepseek-ai/dsh plugin --profile web add --workspace-root ./dist/dsh-tavern-adventure-0.2.0.tgz
```

GitHub 项目名仍为 dsh-tavern，npm 发布名为 `dsh-tavern-adventure`。若曾安装本地旧名 `dsh-tavern` bundle，迁移前先备份，并在原 profile 中停用/移除旧 bundle 配置，避免新旧同时加载；不要删除存档目录。内部存储/API 标识继续兼容旧名，不因 npm 改名而清空存档。

## 本地数据与恢复

默认目录为 `$DSH_HOME/tavern`，未设置时为 `~/.dsh/tavern`，这里指运行 DSH 的主机，不是浏览器所在电脑。没有云端存档同步；在线模型生成所需上下文仍发送给配置的模型服务。

主存储为数据目录中的 `state.json`，通过同目录临时文件 + rename 原子提交，包含剧本版本、冻结快照、本局关系/记忆/已知信息、检定与战斗结果、剧情日志和永久会话绑定，不是浏览器缓存。

### 一致性与备份

- 一个存档同时只有一个推进会话；输入、操作与事件具有幂等标识。普通旧会话不能转游戏，接管只发生在新会话，并使旧会话只读。
- 任意 NPC 调用或写盘失败不提交半个角色状态。角色生成失败可短暂未回应，关系评价失败不伪造好感变化。
- 主存储损坏或丢失会明确报错，**不会自动重置为空白数据**。不要靠删除文件“修复”错误。
- 在停止 DSH 后备份完整数据目录，保留已知正常备份；不要手工编辑正在使用的主存储。

### 进程锁与异常退出

同一目录只允许一个 store handle，正常退出调用 `close()` 释放 `.lock`。锁包含 PID 与随机 nonce。异常退出后，程序在独占 `.lock-recovery` 保护下重新读锁，只有 `process.kill(pid, 0)` 明确返回 ESRCH（旧进程不存在）才恢复锁并保留数据。

活动进程、权限不明、未知锁格式都拒绝抢占。极少数在锁恢复过程中再次崩溃会留下 `.lock-recovery`：先停止所有使用该目录的进程、备份目录，再由本机用户/管理员确认残留锁后处理。程序不会盲删未知锁或坏档；不要在无法确认进程状态时强删锁。

## 架构导航

| 模块 | 职责 |
|---|---|
| [内容与规则](<../lib/core.js>) | 校验、安全公开投影、检定、战斗和转场 |
| [本地存储](<../lib/store.js>) | 导入、快照、原子事务、所有权接管、进程锁与恢复 |
| [游戏运行时](<../lib/runtime.js>) | 真实输入、公开对白、规则操作、幂等与关系事件 |
| [自主决策调度](<../lib/agency.js>) | 独立决策、感知上下文、证据与私有判断 |
| [自主行动规则](<../lib/autonomy.js>) | 能力/目标校验、协助/干扰、挡伤代价、公开/私有投影 |
| [宿主适配](<../lib/index.js>) | 认证 API、会话准入、DM 提示词/工具隔离、子 agent 生命周期 |
| [客户端](<../lib/client.js>) | 原生设置、新会话选择和游戏面板 |
| [本地安装器](<../scripts/install-local.mjs>) | 默认 dry run，显式打包或指定 profile 安装 |

子 agent 结构化报告与感知隔离详见[NPC 架构说明](<npc-autonomy.md#独立-agent-与私有状态>)。框架工具层只开放游戏能力；模型的沉浸叙事与判断质量不能由工具权限保证。

## 验证

```sh
npm test
npm run check
npm run build:demo

# 真实 DSH Loader/解析集成测试：路径指向已安装的 @deepseek-ai 目录
DSH_RUNTIME_DIR=/path/to/node_modules/@deepseek-ai npm test
```

自动化覆盖恶意剧本包、独立快照、断进程恢复、单写接管、NPC 信息隔离、事件幂等和客户端交互，也包含真实 Loader 与嵌套依赖解析验证。未配置对应真实运行时的测试可能跳过，因此应查看具体运行结果，不把命令本身当作全部通过证明。

mock 行为测试验证的是输入、评价、决策、规则和报告之间的管线，**不等于真实在线模型自主表现已经验收**。已登录浏览器的视觉交互、真实 LLM 的角色质量和完整游玩需单独测试；本项目文档不宣称这些已通过。测试数量随版本变化，应以发布归档对应的实际测试输出为准。
