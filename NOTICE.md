# 开源许可声明（NOTICE）

本软件（ChatDesktop，支持 DeepSeek API 与坚果云同步）在以下开源项目的基础上构建，遵循各自的许可协议。

---

## chat-demo

- 仓库：https://github.com/deepseek-ai/chat-demo
- 许可：**MIT License**
- 版权：Copyright (c) DeepSeek
- 使用方式：本软件以其前端代码为基础，增加了桌面壳（Electron）、坚果云 WebDAV 同步、桌面端设置项、新手引导等改动。

原始 MIT 许可要求保留版权声明与许可声明，本文件即履行该义务。原项目的完整许可文本见其仓库 `LICENSE` 文件。

---

## Electron

- 仓库：https://github.com/electron/electron
- 许可：**MIT License**
- 版权：Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.

---

## 主要运行时依赖

| 项目 | 许可 |
|---|---|
| React / React DOM | MIT |
| zustand | MIT |
| fflate | MIT |
| idb | Apache-2.0 |
| markdown 渲染相关（mdast / micromark / remark 生态） | MIT |
| KaTeX | MIT |
| Mermaid | MIT |
| PrismJS | MIT |
| clsx | MIT |

完整的依赖清单与版本见 `chat-demo-src/package.json`。

---

## 关于名称、图标与商标

**本软件的产品名为 `ChatDesktop`**，是一个独立的第三方应用，不是 DeepSeek 或坚果云的官方产品，也未获得任何一方的认证、授权或背书。

### 名称使用

- `ChatDesktop` 是本项目自定的**中性名称**，不包含任何厂商商标
- 描述中出现的 “DeepSeek”，**仅用于说明本软件通过 DeepSeek API 提供服务**（描述性使用），不代表本软件由深度求索公司开发、授权或认证，也不代表本软件是官方客户端
- 描述中出现的 “坚果云”，**仅用于说明同步功能通过坚果云提供的 WebDAV 服务实现**，不代表本软件与坚果云存在合作、授权或隶属关系

### 商标归属

- “DeepSeek” 及相关标识是深度求索公司的商标
- “坚果云” 及相关标识是上海亦存网络科技有限公司的商标
- 本软件**不主张**上述商标的任何权利，也未获得任何形式的官方授权

### 应用图标

- 应用图标（蓝色圆角方形 + 白色鲸鱼剪影）为本项目自行设计（AI 生成后处理）
- 鲸鱼属于通用题材，图标形态与 DeepSeek 官方标识及其他厂商的任何商标均无关联
- 如权利人认为存在不妥，请通过仓库 Issue 联系，作者会及时更换

### 处理机制

如任何一方认为本软件的名称、图标或描述存在不当使用，请联系作者，作者会在合理范围内调整或下架，无需诉诸法律程序。

---

## 本软件的许可

本软件在 `chat-demo` 基础上的新增部分（桌面壳、同步逻辑、设置等）由作者保留权利，发布形式以仓库中的 `LICENSE` 为准。

如需商业使用或再分发，请自行确认同时满足 chat-demo 的 MIT 许可与本项目许可。
