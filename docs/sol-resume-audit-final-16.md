# /sol-resume 方案 A 审核结项：第十六轮 PASS

历经 16 轮复核闭合全部代码级缺陷。第 13–16 轮四次 FAIL 均为证据包完整性问题，非实现缺陷；审核官已在 Linux x64 沙箱独立重建并复现 138/138。

结项时间 2026-09-01

版本 1.12.0

签字作业 c0af3216

裁决 PASS

## 一、签字状态

八个维度全部通过，无遗留 release blocker。

16

复核轮次

含 3 次环境性重试

0

新增缺陷

P0/P1/P2/P3 全零

138

测试通过

reviewer 侧复现

1.12.0

版本

已同步安装副本

### 审核官最终签字清单

| 维度 | 裁决 | 依据 |
| --- | --- | --- |
| CODE | PASS | 第 15 轮即已判定，本轮无改动 |
| R12–R13 SOURCE PROOF | PASS | runtime binding identity 验证通过 |
| FIRST-PARTY TESTS | PASS | 107/107（无依赖 clean-room） |
| TRANSITIVE BUILD CLOSURE | PASS | fs-ext → nan，依赖链已到底 |
| LINUX CLEAN OFFLINE REBUILD | PASS | 产物为 ELF x86-64，非归档内 Mach-O |
| FULL TEST SUITE | PASS | 138 tests / 138 pass / 0 fail / 0 skipped |
| SELF-CONTAINED EVIDENCE | PASS | 归档自身可执行完整测试命令 |
| FINAL VERDICT | PASS | 可签字归档 |

## 二、代码缺陷闭合轨迹

全部代码级问题在第十二轮即已终结，此后四轮零代码改动。

### 已闭合项（按发现轮次）

| 编号 | 问题 | 闭合轮次 |
| --- | --- | --- |
| P1-NEW-1/2 | canonical turn parser 与 resolver | 早期 |
| P1-R6-NEW-1 | redeploy marker 缺失 | 第 7 轮 |
| P1-R8-NEW-1 | prompt hash 两端域不一致 | 第 9 轮 |
| P1-R9-NEW-1 | user/assistant 渲染未分域 | 第 10 轮 |
| P2-R9-NEW-1 | body 两步 selector + fail-closed | 第 10 轮 |
| P2-R8-NEW-2 | 缺 hash anti-collision 行为测试 | 第 11 轮 |
| P1-R12-NEW-1 | R12 缺 redeploy discriminator，R11 坏 worker 可通过 marker fast-path | 第 13 轮 |
| P2-R12-NEW-1 | 缺 nested-template escape 行为级回归测试 | 第 13 轮 |

i

第十二轮的真实故障：worker 源码

`\r\n`

单反斜杠在外层模板求值后变成裸 CR/LF 控制符进入正则字面量，浏览器端抛

`SyntaxError: Invalid regular expression: missing /`

。修复为双转义，使浏览器收到合法

`/\r\n/g`

。

## 三、第 13–16 轮：败在归档，不败在代码

四次 FAIL 的根因是挑文件式归档反复漏依赖，每补一次漏项即消耗一整轮审核。

### 逐轮 blocker 与收敛过程

| 轮次 | 裁决 | 唯一 blocker | 性质 |
| --- | --- | --- | --- |
| 12 | FAIL | escape 深度缺陷 + 缺 discriminator | 真实代码缺陷 |
| 13 | FAIL | 归档缺 `patches.ts`（runtime authority） | 证据缺口 |
| 14 | FAIL | 归档缺 8 个 `lib/sol/*.ts` 支持模块 | 证据缺口 |
| 15 | FAIL | 归档缺 `fs-ext` 的 build dep `nan` | 证据缺口 |
| 16 | PASS | 归档整个 `node_modules/`，闭包由构造保证 | 收敛 |

!

审核官第 15 轮的关键区分：macOS arm64 的

`.node`

不能在 Linux x64 加载属可接受的平台边界；但 rebuild 所需的

`nan`

未归档不能算作平台边界。这一区分使本轮得以收敛。

## 四、第十六轮 reviewer 实测证据

结论来自审核官在自身沙箱的实际执行，而非采信提交方声明。

### Linux x64 clean-room 重建链

| 步骤 | 动作 | 实测结果 |
| --- | --- | --- |
| 1 | 删除 AppleDouble 与既有 build 产物 | pre-build `fs_ext.node` count = 0 |
| 2 | `npm rebuild fs-ext --offline` + 空 cache + 本地 headers | rebuilt dependencies successfully |
| 3 | 校验产物平台 | ELF 64-bit LSB shared object, x86-64 |
| 4 | `npm ls --offline --depth=2` | pi-sol → fs-ext@2.1.1 → nan@2.28.0 |
| 5 | 完整测试命令 | 138 tests / 138 pass / 0 fail / 0 skipped |
| 6 | 代码不变性复核 | 四个关键文件 sha256 与第 15 轮基线一致 |

✓

第 15 轮的两个阻断（

`Cannot find module 'nan'`

、

`ENOTCACHED … nan-2.28.0.tgz`

）在本轮附件上均不再出现。

`--offline`

对空 cache 本身就是依赖闭包的判定器。

## 五、交付物与剩余风险

规则已固化进 skill，避免同类问题再次消耗审核轮次。

### 本轮落盘变更

| 文件 | 变更 |
| --- | --- |
| `skills/sol/SKILL.md` | 新增「Release evidence bundle」章节；Pitfalls 增补提交前负载预检；version 升至 1.12.0 |
| `skills/sol/CHANGELOG.md` | 1.12.0 记录第 16 轮最终 PASS 与三轮归档补漏经过 |
| `~/.pi/agent/skills/sol/` | 按 install.sh:44-45 既有机制同步，与仓库逐字节一致 |

### 剩余风险（均为正常边界，不影响签字）

- **原生依赖**：跨 OS/arch 归档必须继续携带 addon 源码 + build deps 并在目标机 rebuild，不得依赖任何平台预编译 `.node`。
- **宿主工具链**：目标环境需备齐与 Node 版本匹配的 headers、C/C++ 编译器、Python/node-gyp；属 native addon 正常前置条件，非闭包缺陷。
- **归档卫生**：`com.apple.provenance` 受 SIP 保护、`xattr -c` 无法移除，打包时仍会生成 `._*`；建议打包阶段直接过滤，属噪声而非 blocker。
- **运行环境**：并发 pi 会话把 10 核 load 推到 6.65–8.79 时，oracle 作业会超时或读取失败且 `oracle_recover` 无法挽回，已记为待办 PM-DEF-0002。

最终结论

### /sol-resume 方案 A 第十六轮 PASS，可签字归档

代码级 P0/P1/P2/P3 全零，138/138 由审核官在 Linux x64 独立重建复现；归档闭包规则与提交前负载预检已固化进 sol skill 1.12.0。
