<script setup lang="ts">
/**
 * 离线回棚合并：
 *  - 导出整包（棚内/外景分组 + 设备序号）
 *  - 导入整包：容量预演 → 按镜号+帧槽认领 → 新帧顺延 → 冲突留双方值
 *  - 场记选定冲突后才更新当前镜头
 *  - 写入失败自动恢复合并前内容，可重试
 */
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useMergeStore } from '../stores/mergeStore';
import { GROUP_LABELS, type PackageGroup } from '../types/package';
import { FIELD_LABELS } from '../utils/mergeOffline';
import { formatDateTime } from '../utils/format';
import EmptyState from '../components/common/EmptyState.vue';

const mergeStore = useMergeStore();
const { parsed, preflight, report, conflicts, batches, busy, error, pendingConflicts } = storeToRefs(mergeStore);

const importText = ref('');
const fileName = ref('');
const feedback = ref('');

const groupOptions: PackageGroup[] = ['studio', 'location'];

const preflightPct = computed(() => {
  if (!preflight.value || !preflight.value.supported || preflight.value.quota <= 0) return 0;
  return Math.min(100, Math.round((preflight.value.usage / preflight.value.quota) * 100));
});

onMounted(async () => {
  mergeStore.initDevice();
  await Promise.all([mergeStore.loadConflicts(), mergeStore.loadBatches()]);
});

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 3600);
}

async function onExport() {
  const res = await mergeStore.exportPackage();
  flash(res.ok ? '离线包已导出，请妥善保存并整包带回棚内' : `导出失败：${res.error ?? ''}`);
}

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  const text = await file.text();
  importText.value = text;
  await doParse();
}

async function doParse() {
  if (!importText.value.trim()) {
    flash('请先选择离线包文件或粘贴包内容');
    return;
  }
  const res = await mergeStore.loadPackageText(importText.value);
  if (res.ok) {
    flash('包解析通过，容量预演见下方，确认后开始合并');
  } else {
    flash(`整批拒绝：${res.error ?? ''}`);
  }
}

async function doMerge() {
  const res = await mergeStore.confirmMerge();
  if (res.ok) {
    flash(`合并完成：新增镜头 ${res.shotsAdded} · 新增帧 ${res.framesAdded} · 认领帧 ${res.framesClaimed} · 待选定冲突 ${res.conflicts} · 实拍新增 ${res.takesAdded}（去重跳过 ${res.takesSkipped}）`);
    await Promise.all([mergeStore.loadConflicts(), mergeStore.loadBatches()]);
  } else {
    flash(`未合并：${res.rejectReason ?? ''}`);
  }
}

async function doRetry() {
  const res = await mergeStore.retryMerge();
  if (res.ok) {
    flash('重试成功，合并完成');
    await Promise.all([mergeStore.loadConflicts(), mergeStore.loadBatches()]);
  } else {
    flash(`重试仍失败：${res.rejectReason ?? ''}，已恢复合并前内容`);
  }
}

async function resolve(id: number, side: 'local' | 'incoming') {
  await mergeStore.resolveConflict(id, side);
  flash(`已采用${side === 'local' ? '棚内' : '外景'}值，当前镜头已更新`);
}

function fieldLabel(f: string): string {
  return FIELD_LABELS[f] ?? f;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>离线回棚合并</h1>
        <p class="sub">棚内 / 外景离线排同一镜头，回棚整包导入：按镜号 + 帧槽认领，新帧顺延，冲突留双方值等场记选定</p>
      </div>
    </header>

    <p v-if="feedback" class="feedback" data-testid="merge-feedback">{{ feedback }}</p>
    <p v-if="error" class="feedback err" data-testid="merge-error">{{ error }}</p>

    <div class="two-panel">
      <!-- 导出 -->
      <div class="panel">
        <div class="panel-head"><h2>导出离线包</h2><span class="muted">整包 JSON，回棚后只能整包导入</span></div>
        <div class="form-grid">
          <label class="field">
            <span>分组</span>
            <select v-model="mergeStore.group" data-testid="export-group">
              <option v-for="g in groupOptions" :key="g" :value="g">{{ GROUP_LABELS[g] }}</option>
            </select>
          </label>
          <label class="field">
            <span>设备序号</span>
            <input v-model="mergeStore.deviceSerial" data-testid="export-device" />
          </label>
        </div>
        <div class="actions">
          <button type="button" class="btn primary" :disabled="busy" data-testid="export-submit" @click="onExport">导出整包 JSON</button>
          <span class="muted" v-if="mergeStore.lastExportAt">最近导出：{{ formatDateTime(mergeStore.lastExportAt) }}</span>
        </div>
        <p class="muted note">导出内容含全部镜头、帧条目、道具状态与实拍记录；帧条目不携带对方设备的自增 id，回棚按镜号 + 帧槽认领。</p>
      </div>

      <!-- 导入 -->
      <div class="panel">
        <div class="panel-head"><h2>导入离线包</h2><span class="muted">导入前按浏览器剩余空间预演</span></div>
        <div class="import-row">
          <input type="file" accept="application/json,.json" data-testid="import-file" @change="onFile" />
          <button type="button" class="btn" :disabled="busy" @click="doParse">解析包</button>
        </div>
        <textarea
          v-model="importText"
          class="paste"
          placeholder="也可以直接粘贴离线包 JSON 内容…"
          data-testid="import-paste"
        ></textarea>

        <template v-if="parsed">
          <div class="pkg-meta" data-testid="pkg-meta">
            <div><span class="muted">包标识</span><code>{{ parsed.packageId }}</code></div>
            <div><span class="muted">分组</span>{{ GROUP_LABELS[parsed.group] }} · {{ parsed.deviceSerial }}</div>
            <div><span class="muted">导出时间</span>{{ formatDateTime(parsed.exportedAt) }}</div>
            <div><span class="muted">内容</span>镜头 {{ parsed.shots.length }} · 帧 {{ parsed.frames.length }} · 道具 {{ parsed.props.length }} · 实拍 {{ parsed.takes.length }}</div>
          </div>

          <div v-if="preflight" class="preflight" :class="{ ok: preflight.ok, bad: !preflight.ok }" data-testid="preflight">
            <div class="preflight-head">
              <strong>合并前容量预演</strong>
              <span v-if="!preflight.ok" class="badge bad">整批拒绝</span>
              <span v-else class="badge ok">空间充足</span>
            </div>
            <div class="preflight-bar">
              <div class="preflight-fill" :style="{ width: preflightPct + '%' }"></div>
              <div class="preflight-need" :style="{ left: 'calc(100% - 2px)' }"></div>
            </div>
            <div class="preflight-grid">
              <span>包体 {{ fmtBytes(preflight.bytes) }}</span>
              <span>预估需要 {{ fmtBytes(preflight.needed) }}</span>
              <span>剩余 {{ fmtBytes(preflight.remaining) }}</span>
              <span v-if="preflight.supported">配额 {{ fmtBytes(preflight.quota) }}</span>
              <span v-else class="muted">浏览器未上报配额，写入时仍有快照回滚兜底</span>
            </div>
            <p v-if="!preflight.ok" class="err">剩余空间不足，整批拒绝合并；本地数据与离线包均保留原样，清理空间后可重新导入。</p>
          </div>

          <div class="actions">
            <button type="button" class="btn primary" :disabled="busy || !preflight?.ok" data-testid="merge-submit" @click="doMerge">
              {{ busy ? '合并中…' : '确认合并' }}
            </button>
            <button type="button" class="btn" :disabled="busy" @click="mergeStore.clearParsed">清空</button>
          </div>
        </template>

        <template v-if="report">
          <div class="report" :class="{ ok: report.ok, bad: !report.ok }" data-testid="merge-report">
            <template v-if="report.ok">
              <strong>合并完成</strong>
              <ul>
                <li>镜头：新增 {{ report.shotsAdded }}，认领 {{ report.shotsMatched }}</li>
                <li>帧：新增 {{ report.framesAdded }}（接在原顺序后），认领 {{ report.framesClaimed }}</li>
                <li>待场记选定冲突：{{ report.conflicts }} 条（见下方列表）</li>
                <li>实拍：新增 {{ report.takesAdded }}，去重跳过 {{ report.takesSkipped }}（进度不回退）</li>
                <li>道具：新增 {{ report.propsAdded }}，更新 {{ report.propsUpdated }}</li>
              </ul>
            </template>
            <template v-else>
              <strong>未合并（{{ report.rejected ? '整批拒绝' : '写入失败，已恢复合并前内容' }}）</strong>
              <p>{{ report.rejectReason }}</p>
              <button v-if="!report.rejected" type="button" class="btn primary" :disabled="busy" data-testid="merge-retry" @click="doRetry">重试合并</button>
            </template>
          </div>
        </template>
      </div>
    </div>

    <!-- 冲突选定 -->
    <div class="panel">
      <div class="panel-head">
        <h2>待场记选定的冲突</h2>
        <span class="muted">同一帧两边都改了曝光或位移，留双方值；选定后才更新当前镜头</span>
      </div>
      <EmptyState
        v-if="!conflicts.length"
        title="暂无冲突"
        description="合并时若同一帧两边都改了曝光或道具位移，会在这里列出双方值供选定。"
      />
      <div v-else class="conflict-list" data-testid="conflict-list">
        <div v-for="c in conflicts" :key="c.id" class="conflict" :class="{ resolved: c.status === 'resolved' }">
          <div class="conflict-head">
            <strong>{{ c.shotCode }} · 第 {{ c.frameNo }} 帧槽</strong>
            <span v-if="c.status === 'resolved'" class="badge ok">已采用{{ c.resolution === 'local' ? '棚内' : '外景' }}值</span>
            <span v-else class="badge warn">待选定</span>
          </div>
          <table class="conflict-table">
            <thead>
              <tr><th>字段</th><th>棚内值（先回）</th><th>外景值（包内）</th></tr>
            </thead>
            <tbody>
              <tr v-for="f in c.fields" :key="f">
                <td>{{ fieldLabel(f) }}</td>
                <td>{{ (c.local as unknown as Record<string, unknown>)[f] }}</td>
                <td>{{ (c.incoming as unknown as Record<string, unknown>)[f] }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="c.status === 'pending'" class="actions">
            <button type="button" class="btn small" data-testid="conflict-local" @click="resolve(c.id!, 'local')">采用棚内值</button>
            <button type="button" class="btn small primary" data-testid="conflict-incoming" @click="resolve(c.id!, 'incoming')">采用外景值</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 导入历史 -->
    <div class="panel">
      <div class="panel-head"><h2>导入历史</h2><span class="muted">按包 + 设备序号留痕，同包不重复导入</span></div>
      <EmptyState v-if="!batches.length" title="还没有导入记录" description="导入离线包后会在这里留痕。" />
      <table v-else class="table" data-testid="batch-table">
        <thead>
          <tr><th>包标识</th><th>分组</th><th>设备序号</th><th>导入时间</th><th>新增镜头</th><th>新增帧</th><th>认领帧</th><th>实拍新增</th><th>去重跳过</th></tr>
        </thead>
        <tbody>
          <tr v-for="b in batches" :key="b.id">
            <td><code>{{ b.packageId }}</code></td>
            <td>{{ GROUP_LABELS[b.group] }}</td>
            <td>{{ b.deviceSerial }}</td>
            <td>{{ formatDateTime(b.importedAt) }}</td>
            <td>{{ b.shotsAdded }}</td>
            <td>{{ b.framesAdded }}</td>
            <td>{{ b.framesClaimed }}</td>
            <td>{{ b.takesAdded }}</td>
            <td>{{ b.takesSkipped }}</td>
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
.page-head h1 {
  margin: 0;
  font-size: 22px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.feedback {
  margin: 0;
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.feedback.err,
.err {
  color: #c45656;
}
.feedback.err {
  background: #fdf0f0;
  border-color: #f0c8c8;
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
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field input,
.field select {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.note {
  margin: 0;
  line-height: 1.6;
}
.import-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.paste {
  width: 100%;
  min-height: 96px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  box-sizing: border-box;
}
.pkg-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: #3d4757;
  background: #f5f8ff;
  border: 1px solid #dbe6ff;
  border-radius: 8px;
  padding: 10px 12px;
}
.pkg-meta code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #2f6fed;
}
.preflight {
  border: 1px solid #e2e7ef;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.preflight.ok {
  background: #f3fbf5;
  border-color: #c8e6cf;
}
.preflight.bad {
  background: #fdf0f0;
  border-color: #f0c8c8;
}
.preflight-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
.preflight-bar {
  position: relative;
  height: 10px;
  background: #edf0f5;
  border-radius: 6px;
  overflow: visible;
}
.preflight-fill {
  height: 100%;
  background: #7aa7ff;
  border-radius: 6px;
}
.preflight-need {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: #c45656;
}
.preflight-grid {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #5a6472;
}
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
}
.badge.ok {
  background: #e3f6e8;
  color: #2e7d32;
}
.badge.bad {
  background: #fde8e8;
  color: #c45656;
}
.badge.warn {
  background: #fff4e0;
  color: #b26a00;
}
.report {
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
}
.report.ok {
  background: #f3fbf5;
  border: 1px solid #c8e6cf;
  color: #2e7d32;
}
.report.bad {
  background: #fdf0f0;
  border: 1px solid #f0c8c8;
  color: #c45656;
}
.report ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.report p {
  margin: 6px 0 0;
}
.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.conflict {
  border: 1px solid #e2e7ef;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.conflict.resolved {
  opacity: 0.75;
}
.conflict-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
.conflict-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.conflict-table th,
.conflict-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid #eef1f6;
}
.conflict-table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
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
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.table code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #2f6fed;
  font-size: 12px;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
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
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
