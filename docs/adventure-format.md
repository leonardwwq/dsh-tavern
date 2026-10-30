# 剧本格式与安全边界

[返回首页](<../README.md>) · [示例指南](<../demo/README.md>) · [NPC 自主性](<npc-autonomy.md>)

## 导入入口与 ZIP 结构

在设置的「地城冒险」中管理剧本，也可以从新会话选择面板导入 ZIP。可导入示例：[这帮人脑子好像都有问题 ZIP](<../demo/curtain-castle.zip>)；可编辑源文件：[剧本配置](<../demo/curtain-castle/adventure.yaml>)、[包清单](<../demo/curtain-castle/manifest.yaml>)。

ZIP 根目录直接包含清单和内容，不要额外套外层文件夹：

```text
manifest.yaml                 # 或 manifest.yml / manifest.json，三者只能有一个
adventure.yaml
characters/warrior.yaml
characters/ranger.yaml
characters/cleric.yaml
assets/cover.png              # 可选静态图片
```

```yaml
formatVersion: 1
id: my-dungeon
version: 1.0.0
title: 我的地下城
description: 四人小队的一次短篇冒险。
author: 剧本作者
capabilities: [cultivation.external.v1]
adventure: adventure.yaml
characters:
  - characters/warrior.yaml
  - characters/ranger.yaml
  - characters/cleric.yaml
```

当前只支持 `formatVersion: 1` 和 `cultivation.external.v1`。内容为 YAML/JSON 与可选 `assets/` 下的 PNG、JPEG、WebP、GIF；资源以 base64 随版本保存，当前示例无需图片。不得包含未引用文档、可执行文件、符号链接或其他类型资源。

## 声明式内容字段

| 内容 | 字段与约定 |
|---|---|
| 剧本 | `dm`、`player`、`entry`、`scenes` |
| DM | 可配置 `name/style/world/rules/secrets`，装入主会话内部设定，不作为公共面板数据返回 |
| NPC | `id/name/role/goal/fields`，可选 `initialState/reactions`；只使用剧本内 ID，不查询全局角色库 |
| 初始关系 | `initialState.intimacy`；玩家是虚构角色，不沿用日常聊天用户关系 |
| 初始认知 | `initialState.knows`；角色私人设定与知识应写在自己内容中，不能只写入 DM 秘密就假定 NPC 自动知道 |
| 场景 | `id/place/opening/cast/exits`，可选 `timeOfDay/npcGoals/checks/encounter/allowRest/ending` |
| 出口 | `exits[].requires` 是平铺旗标等值条件，例如 `{hidden_route: true}`，目的地必须存在 |
| 检定 | `id/label/dc/bonus?/successFlags?/failureFlags?/repeatable?`；默认不可重掷，成功/失败只应用作者定义的旗标 |
| 遭遇 | `id/name/hp/armorClass/attackBonus?/damage?/rewardFlags?` |
| 休整与结束 | `allowRest: true` 允许休整恢复；`ending: true` 进入即完成 |

完整字段与分支以[内置剧本](<../demo/curtain-castle/adventure.yaml>)及其[角色内容](<../demo/curtain-castle/characters/warrior.yaml>)为例。DM 背景/秘密、角色 `fields` 与 `initialState` 不出现在公共列表中。NPC 不替代骰点，DM 不能临时传入任意旗标。

首期只接受声明式数据和静态图片，**不执行**包内 JS、脚本、安装钩子或自定义宿主工具。剧本提示词不能扩大框架工具权限。安全校验约束文件和执行边界，不保证作者内容真实、适宜，也不保证生成模型完全遵守叙事要求。

## 校验、安全限额与版本

内容先在内存完整解析校验，再原子保存，不解压到任意磁盘路径。未知格式/能力、缺文件、重名 ID、无效场景/角色/出口引用会报具体错误，不产生半导入内容。

`IMPORT_LIMITS` 的工程限额：

- 压缩 ZIP ≤ 5 MiB，总展开 ≤ 20 MiB，单项 ≤ 5 MiB，最多 128 项，JSON 深度 ≤ 64。
- 拒绝路径穿越、绝对路径（含 Windows 路径）、反斜杠、重复 ZIP 路径、符号链接/特殊条目、别名 YAML 和执行内容。
- 拒绝加密、非 store/deflate 压缩、多卷 ZIP 和 ZIP64，以及非法引用和不支持的能力。

版本规则：

1. 同 ID + 同版本 + 相同规范化内容重复导入是幂等操作；同版本不同内容拒绝覆盖，更新必须增加版本号。
2. 新旧版本并存；开团冻结整个剧本快照，修改源包或导入新版本不改变已开局。
3. 归档只隐藏常用入口并阻止新开游戏，不影响已有存档接管续玩；任何存档引用的剧本版本都不能删除。

## 重新构建示例

在项目根目录执行：

```sh
npm run build:demo
```

生成的[示例 ZIP](<../demo/curtain-castle.zip>)会经过正式解析器验证。内置初始化可使用受信任的 `store.importDirectory()` 读取[示例目录](<../demo/README.md>)；**不要把文件系统路径导入接口暴露给远端用户**。
