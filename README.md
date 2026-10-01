# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单/导出设置草稿） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take,offline}.ts  # 数据模型 + 离线包/冲突模型
        ├── stores/{shotStore,frameStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft,useOfflineMerge}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog,OfflineMerge}.vue
        ├── router/index.ts
        ├── services/{offlinePackage,mergeEngine}.ts  # 离线整包导出/解析 + 回棚合并引擎
        ├── utils/{frameMath,frameKey,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v4 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数与待拍张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目 |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、帧条目表格、道具轨迹、登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长 |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比并提示剩余张数；场记确认后进度不可被离线合并回退 |
| `/merge` | 离线回棚合并 | 棚内/外景整包导出与导入，按镜号+帧槽认领合并、容量预演、冲突裁决 |

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录、合并冲突五张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；
  `v4` 帧增加稳定标识 `frameKey`（旧帧按「镜号 + 帧槽」确定性回填，与离线设备算得一致）、
  `takes` 增加去重键 `dedupeKey` 与确认标记，并新增 `conflicts` 表。
- **离线回棚合并（`/merge`）**：棚内、外景两组各自整包导出（JSON），回棚后两包一起合并。
  - 帧按「镜号 + 帧槽（稳定帧标识）」认领：已有帧就地合并，新增帧接在原顺序后并重排帧序号；
  - 同一帧的曝光组、道具位移、实拍张数两边都有新值且不同 → 双方值写入冲突表，当前镜头保持原值，场记在页面选定后才更新；
  - 实拍记录按「来源包 + 设备序号 + 记录序号」去重，已确认进度只升不降；
  - 提交前用 `navigator.storage.estimate` 预演容量，不足整批拒绝、不写任何数据，两个包继续保留；
  - 提交为单事务，事务外另有整库快照兜底：写入失败恢复合并前内容，包保留、可原样重试。
- **localStorage**：新建镜头表单、批量曝光参数与离线导出设置草稿，键前缀 `gbstopmotion:draft:`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
