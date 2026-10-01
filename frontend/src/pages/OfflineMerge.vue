<script setup lang="ts">
/**
 * 离线回棚合并：
 * - 棚内 / 外景两组离线数据整包导入，按镜号 + 帧槽（稳定帧标识）认领；
 * - 新增帧接在原顺序后；曝光组 / 道具位移 / 实拍张数双方都有新值时挂起，
 *   保留双方值等场记选定，选定前不动当前镜头；
 * - 实拍记录按「来源包 + 设备序号 + 记录序号」去重，已确认进度不回退；
 * - 合并前按浏览器剩余空间预演，容量不足整批拒绝并保留两个包；
 * - 写入失败引擎自动恢复合并前内容，本页可直接重试。
 */
import { onMounted, reactive, ref } from 'vue';
import { useShotStore } from '../stores/shotStore';
import { useOfflineMerge } from '../hooks/useOfflineMerge';
import { buildOfflinePackage, downloadPackage } from '../services/offlinePackage';
import * as api from '../db/api';
import { formatDateTime } from '../utils/format';
import { readDraft, writeDraft } from '../hooks/useLocalDraft';
import {
  CONFLICT_KIND_LABEL,
  CONFLICT_SIDE_LABEL,
  OFFLINE_GROUPS,
  type ConflictSide,
  type OfflineGroup,
  type PendingConflict,
} from '../types/offline';
import type { ExposureBundle } from '../types/frame';

const shotStore = useShotStore();
const {
  studioPkg,
  locationPkg,
  studioFileName,
  locationFileName,
  status,
  notice,
  plan,
  pendingConflicts,
  resolvedConflicts,
  merging,
  canMerge,
  importPackage,
  clearPackages,
  runMerge,
  loadConflicts,
  chooseSide,
} = useOfflineMerge();

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  await loadConflicts();
});

/** 导出设置按分组记忆到 localStorage（设备序号每台机器固定） */
const exportSettings = reactive(
  readDraft<Record<OfflineGroup, { deviceSeq: number; producer: string }>>('offline-export-settings') ?? {
    棚内: { deviceSeq: 1, producer: '' },
    外景: { deviceSeq: 2, producer: '' },
  },
);
const exporting = ref<OfflineGroup | null>(null);

function persistSettings(): void {
  writeDraft('offline-export-settings', exportSettings);
}

async function exportCurrent(group: OfflineGroup): Promise<void> {
  exporting.value = group;
  try {
    const [frames, takes] = await Promise.all([api.listAllFrames(), api.listAllTakes()]);
    const pkg = buildOfflinePackage(
      { shots: shotStore.shots, frames, takes },
      {
        group,
        deviceSeq: exportSettings[group].deviceSeq,
        producer: exportSettings[group].producer,
      },
    );
    persistSettings();
    downloadPackage(pkg);
  } finally {
    exporting.value = null;
  }
}

async function handleFileChange(file: { raw?: File }, group: OfflineGroup): Promise<void> {
  if (!file.raw) return;
  await importPackage(group, file.raw);
}

function onStudioChange(file: { raw?: File }): void {
  void handleFileChange(file, '棚内');
}

function onLocationChange(file: { raw?: File }): void {
  void handleFileChange(file, '外景');
}

function onExceed(): void {
  // limit=1，多余文件 el-upload 自身会拒绝；不做额外处理
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '未知（浏览器未提供配额，跳过容量校验）';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function valueText(conflict: PendingConflict, side: ConflictSide): string {
  const raw = side === 'studio' ? conflict.studioValue : conflict.locationValue;
  if (conflict.kind === 'exposure') {
    const b = JSON.parse(raw) as ExposureBundle;
    return `曝光 ${b.exposureSec}s · f/${b.aperture} · ISO ${b.iso} · 快门角 ${b.shutterAngle}° · ${b.lighting}`;
  }
  if (conflict.kind === 'offset') return `位移 ${JSON.parse(raw) as number} mm`;
  return `实拍 ${JSON.parse(raw) as number} 张/帧`;
}

function baseText(conflict: PendingConflict): string {
  if (conflict.kind === 'exposure') {
    const b = JSON.parse(conflict.baseValue) as ExposureBundle;
    return `${b.exposureSec}s · f/${b.aperture} · ISO ${b.iso} · ${b.shutterAngle}°`;
  }
  if (conflict.kind === 'offset') return `${JSON.parse(conflict.baseValue) as number} mm`;
  return `${JSON.parse(conflict.baseValue) as number} 张/帧`;
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>离线回棚合并</h1>
        <p class="sub">棚内、外景两组离线数据整包导入：按镜号 + 帧槽认领，新增帧接原顺序；双方新值冲突时等场记裁决</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn" @click="clearPackages" :disabled="merging">清空重选</button>
      </div>
    </header>

    <p v-if="notice" :class="['feedback', notice.type]" data-testid="merge-notice">{{ notice.text }}</p>

    <div class="panel" data-testid="export-panel">
      <div class="panel-head">
        <h2>导出离线整包</h2>
        <span class="muted">棚内 / 外景各自导出，设备序号每台机器固定（实拍记录按它去重）</span>
      </div>
      <div class="export-grid">
        <div v-for="group in OFFLINE_GROUPS" :key="group" class="export-card">
          <strong>{{ group }}机导出</strong>
          <label class="field">
            <span>设备序号</span>
            <input v-model.number="exportSettings[group].deviceSeq" type="number" min="1" max="99" step="1" @change="persistSettings" />
          </label>
          <label class="field grow">
            <span>操作人备注</span>
            <input v-model="exportSettings[group].producer" type="text" maxlength="20" placeholder="可选" @change="persistSettings" />
          </label>
          <button type="button" class="btn primary" :disabled="exporting !== null" @click="exportCurrent(group)">
            {{ exporting === group ? '导出中…' : `导出${group}包` }}
          </button>
        </div>
      </div>
    </div>

    <div class="two-panel">
      <div class="panel" data-testid="studio-drop">
        <div class="panel-head">
          <h2>棚内包</h2>
          <span v-if="studioPkg" class="pill ok">已导入</span>
        </div>
        <el-upload
          drag
          :auto-upload="false"
          :limit="1"
          :on-exceed="onExceed"
          :on-change="onStudioChange"
          accept=".json,application/json"
        >
          <div class="upload-inner">
            <strong>{{ studioFileName || '拖入或选择棚内离线包（.json）' }}</strong>
            <span v-if="studioPkg" class="muted">
              {{ studioPkg.meta.deviceSeq }} 号机 · 导出于 {{ formatDateTime(studioPkg.meta.exportedAt) }}
            </span>
          </div>
        </el-upload>
        <ul v-if="studioPkg" class="meta-list">
          <li>镜头 {{ studioPkg.shots.length }} 个</li>
          <li>帧 {{ studioPkg.frames.length }} 条</li>
          <li>实拍记录 {{ studioPkg.takes.length }} 条</li>
        </ul>
      </div>

      <div class="panel" data-testid="location-drop">
        <div class="panel-head">
          <h2>外景包</h2>
          <span v-if="locationPkg" class="pill ok">已导入</span>
        </div>
        <el-upload
          drag
          :auto-upload="false"
          :limit="1"
          :on-exceed="onExceed"
          :on-change="onLocationChange"
          accept=".json,application/json"
        >
          <div class="upload-inner">
            <strong>{{ locationFileName || '拖入或选择外景离线包（.json）' }}</strong>
            <span v-if="locationPkg" class="muted">
              {{ locationPkg.meta.deviceSeq }} 号机 · 导出于 {{ formatDateTime(locationPkg.meta.exportedAt) }}
            </span>
          </div>
        </el-upload>
        <ul v-if="locationPkg" class="meta-list">
          <li>镜头 {{ locationPkg.shots.length }} 个</li>
          <li>帧 {{ locationPkg.frames.length }} 条</li>
          <li>实拍记录 {{ locationPkg.takes.length }} 条</li>
        </ul>
      </div>
    </div>

    <div class="panel actions-panel">
      <div>
        <strong>合并前自动按浏览器剩余空间预演</strong>
        <span class="muted">容量不足将整批拒绝、不写任何数据，两个离线包继续保留，可重新预演或重试。</span>
      </div>
      <button type="button" class="btn primary" data-testid="merge-run" :disabled="!canMerge" @click="runMerge">
        {{ merging ? '合并中…' : status === 'failed' || status === 'rejected' ? '重新合并（重试）' : '预演并合并两个包' }}
      </button>
    </div>

    <div v-if="plan?.preview" class="panel" data-testid="capacity-preview">
      <div class="panel-head"><h2>容量预演</h2></div>
      <dl class="capacity-grid">
        <div><dt>本次预计写入</dt><dd>{{ formatBytes(plan.preview.requiredBytes) }}</dd></div>
        <div><dt>已用空间</dt><dd>{{ formatBytes(plan.preview.usage) }}</dd></div>
        <div><dt>浏览器配额</dt><dd>{{ formatBytes(plan.preview.quota) }}</dd></div>
        <div>
          <dt>剩余可用</dt>
          <dd :class="{ insufficient: !plan.preview.enough }">{{ formatBytes(plan.preview.available) }}</dd>
        </div>
        <div>
          <dt>结论</dt>
          <dd :class="plan.preview.enough ? 'ok-text' : 'err-text'">
            {{ plan.preview.enough ? '空间充足，已执行合并' : '空间不足，已整批拒绝（两包保留）' }}
          </dd>
        </div>
      </dl>
    </div>

    <div v-if="plan && plan.stats.length" class="panel" data-testid="merge-stats">
      <div class="panel-head">
        <h2>合并结果</h2>
        <span class="muted">新增帧 {{ plan.totalAppendedFrames }} · 实拍 {{ plan.totalTakesAdded }} 条 · 冲突 {{ plan.totalConflicts }} 处</span>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>镜号</th>
            <th>镜头</th>
            <th>认领帧</th>
            <th>新增帧</th>
            <th>就地更新</th>
            <th>新增实拍</th>
            <th>冲突</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="stat in plan.stats" :key="stat.shotCode">
            <td class="mono">{{ stat.shotCode }}</td>
            <td>{{ stat.shotExisted ? '原有' : '新建' }}</td>
            <td>{{ stat.claimedFrames }}</td>
            <td>{{ stat.appendedFrames }}</td>
            <td>{{ stat.updatedFrames }}</td>
            <td>{{ stat.takesAdded }}</td>
            <td :class="stat.conflicts ? 'warn-text' : ''">{{ stat.conflicts }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel" data-testid="conflict-panel">
      <div class="panel-head">
        <h2>待场记裁决（{{ pendingConflicts.length }}）</h2>
        <span class="muted">同帧双方新值不同；选定前当前镜头保持原值，点「采用」后才写入</span>
      </div>
      <table v-if="pendingConflicts.length" class="table">
        <thead>
          <tr>
            <th>镜号</th>
            <th>帧槽</th>
            <th>项目</th>
            <th>当前值</th>
            <th>{{ CONFLICT_SIDE_LABEL.studio }}</th>
            <th>{{ CONFLICT_SIDE_LABEL.location }}</th>
            <th>裁决</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in pendingConflicts" :key="c.id">
            <td class="mono">{{ c.shotCode }}</td>
            <td class="mono">#{{ c.slot }}</td>
            <td>{{ CONFLICT_KIND_LABEL[c.kind] }}</td>
            <td class="muted">{{ baseText(c) }}</td>
            <td>
              <div class="choice studio-choice">
                <span class="dot studio" />
                {{ valueText(c, 'studio') }}
              </div>
            </td>
            <td>
              <div class="choice location-choice">
                <span class="dot location" />
                {{ valueText(c, 'location') }}
              </div>
            </td>
            <td class="row-actions">
              <button type="button" class="btn tiny primary" @click="chooseSide(c, 'studio')">采用棚内</button>
              <button type="button" class="btn tiny primary" @click="chooseSide(c, 'location')">采用外景</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">没有待裁决的冲突。</p>
    </div>

    <div v-if="resolvedConflicts.length" class="panel">
      <div class="panel-head"><h2>已裁决（{{ resolvedConflicts.length }}）</h2></div>
      <table class="table">
        <thead>
          <tr><th>镜号</th><th>帧槽</th><th>项目</th><th>采用</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in resolvedConflicts" :key="c.id">
            <td class="mono">{{ c.shotCode }}</td>
            <td class="mono">#{{ c.slot }}</td>
            <td>{{ CONFLICT_KIND_LABEL[c.kind] }}</td>
            <td>{{ c.chosen ? CONFLICT_SIDE_LABEL[c.chosen] : '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
h2 {
  margin: 0;
  font-size: 16px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.two-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 1100px) {
  .two-panel {
    grid-template-columns: 1fr;
  }
}
.upload-inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 0;
}
.meta-list {
  display: flex;
  gap: 16px;
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  font-size: 12px;
  color: #5a6472;
}
.feedback {
  margin: 0;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.feedback.info {
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
}
.feedback.success {
  background: #eafaf0;
  border: 1px solid #c4ecd2;
  color: #1f7a41;
}
.feedback.warning {
  background: #fff7e8;
  border: 1px solid #ffe0a3;
  color: #9a6507;
}
.feedback.error {
  background: #fdeeee;
  border: 1px solid #f5c6c6;
  color: #b04545;
}
.actions-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.export-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 1100px) {
  .export-grid {
    grid-template-columns: 1fr;
  }
}
.export-card {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  border: 1px solid #e2e7ef;
  border-radius: 8px;
  padding: 12px;
  background: #fafbfe;
}
.export-card strong {
  font-size: 13px;
  white-space: nowrap;
  padding-bottom: 6px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field.grow {
  flex: 1;
}
.field input {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
}
.capacity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 18px;
  margin: 0;
}
.capacity-grid div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.capacity-grid dt {
  font-size: 12px;
  color: #8a94a6;
}
.capacity-grid dd {
  margin: 0;
  font-size: 14px;
}
.insufficient,
.err-text,
.warn-text {
  color: #c45656;
  font-weight: 600;
}
.ok-text {
  color: #1f7a41;
  font-weight: 600;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: middle;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.choice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.dot.studio {
  background: #2f6fed;
}
.dot.location {
  background: #d99b2b;
}
.row-actions {
  display: flex;
  gap: 6px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pill {
  font-size: 12px;
  border-radius: 999px;
  padding: 2px 10px;
}
.pill.ok {
  background: #eafaf0;
  color: #1f7a41;
}
</style>
