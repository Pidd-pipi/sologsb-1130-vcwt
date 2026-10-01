/**
 * 离线回棚合并 store：
 *  - 导出整包 JSON（棚内/外景分组 + 设备序号）
 *  - 导入整包：解析 → 容量预演 → 快照 → 合并 → 失败回滚快照并允许重试
 *  - 冲突留双方值，场记选定后再更新当前镜头
 *  - 实拍记录按包 + 设备序号去重，进度只进不退
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import {
  createPackageId,
  mergeProps,
  mergeShots,
  mergeShotFrames,
  mergeTakes,
  parsePackageText,
  storagePreflight,
  type FrameConflictDesc,
} from '../utils/mergeOffline';
import { getDeviceSerial } from '../utils/device';
import type { FrameEntry } from '../types/frame';
import type { Shot } from '../types/shot';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { FrameConflict } from '../types/conflict';
import {
  GROUP_LABELS,
  type MergeBatch,
  type MergeReport,
  type OfflinePackage,
  type PackageGroup,
  type StoragePreflight,
} from '../types/package';

interface MergeState {
  deviceSerial: string;
  group: PackageGroup;
  parsed: OfflinePackage | null;
  preflight: StoragePreflight | null;
  report: MergeReport | null;
  conflicts: FrameConflict[];
  batches: MergeBatch[];
  busy: boolean;
  error: string;
  lastExportAt: number | null;
}

export const useMergeStore = defineStore('merge', {
  state: (): MergeState => ({
    deviceSerial: '',
    group: 'studio',
    parsed: null,
    preflight: null,
    report: null,
    conflicts: [],
    batches: [],
    busy: false,
    error: '',
    lastExportAt: null,
  }),
  getters: {
    pendingConflicts(state): FrameConflict[] {
      return state.conflicts.filter((c) => c.status === 'pending');
    },
  },
  actions: {
    initDevice() {
      if (!this.deviceSerial) this.deviceSerial = getDeviceSerial();
    },
    setGroup(group: PackageGroup) {
      this.group = group;
    },

    /* ---------------- 导出整包 ---------------- */

    async exportPackage(): Promise<{ ok: boolean; error?: string }> {
      this.initDevice();
      this.busy = true;
      this.error = '';
      try {
        const [shots, frames, props, takes] = await Promise.all([
          api.listShots(),
          api.listAllFrames(),
          api.listAllProps(),
          api.listTakes(),
        ]);
        const pkg: OfflinePackage = {
          format: 'gbstopmotion-offline-package',
          version: 1,
          packageId: createPackageId(),
          deviceSerial: this.deviceSerial,
          group: this.group,
          exportedAt: Date.now(),
          appVersion: '1.0.0',
          shots: shots.map((s) => toPlain(s)),
          frames: frames.map((f) => toPlain(f)),
          props: props.map((p) => toPlain(p)),
          takes: takes.map((t) => toPlain(t)),
        };
        const json = JSON.stringify(pkg, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date(pkg.exportedAt);
        const pad = (n: number) => String(n).padStart(2, '0');
        const fname = `gbstopmotion-package-${this.group}-${this.deviceSerial}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`;
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.lastExportAt = pkg.exportedAt;
        return { ok: true };
      } catch (e) {
        this.error = e instanceof Error ? e.message : '导出失败';
        return { ok: false, error: this.error };
      } finally {
        this.busy = false;
      }
    },

    /* ---------------- 导入：解析 + 容量预演 ---------------- */

    async loadPackageText(text: string): Promise<{ ok: boolean; error?: string }> {
      this.initDevice();
      this.error = '';
      this.report = null;
      const { pkg, error } = parsePackageText(text);
      if (error || !pkg) {
        this.parsed = null;
        this.preflight = null;
        this.error = error ?? '包解析失败';
        return { ok: false, error: this.error };
      }
      this.parsed = pkg;
      this.preflight = await storagePreflight(pkg);
      if (!this.preflight.ok) {
        this.error = `浏览器剩余空间不足：预计需要 ${formatBytes(this.preflight.needed)}，剩余 ${formatBytes(this.preflight.remaining)}。整批已拒绝，两个包均保留原样。`;
      }
      return { ok: this.preflight.ok, error: this.preflight.ok ? undefined : this.error };
    },

    clearParsed() {
      this.parsed = null;
      this.preflight = null;
      this.report = null;
      this.error = '';
    },

    /* ---------------- 合并 ---------------- */

    async confirmMerge(): Promise<MergeReport> {
      if (!this.parsed) {
        return this.rejectReport('没有可导入的离线包');
      }
      if (this.preflight && !this.preflight.ok) {
        return this.rejectReport(this.error || '容量预演未通过，整批拒绝');
      }
      this.busy = true;
      this.error = '';
      const pkg = this.parsed;
      try {
        const report = await this.runMerge(pkg);
        this.report = report;
        if (!report.ok) this.error = report.rejectReason ?? '合并被拒绝';
        return report;
      } catch (e) {
        // 写入失败：runMerge 内已恢复合并前内容，这里给出可重试的报告
        this.error = e instanceof Error ? e.message : '合并写入失败，已恢复合并前内容';
        const report: MergeReport = {
          ok: false,
          rejected: false,
          rejectReason: this.error,
          packageId: pkg.packageId,
          deviceSerial: pkg.deviceSerial,
          group: pkg.group,
          exportedAt: pkg.exportedAt,
          shotsAdded: 0,
          shotsMatched: 0,
          framesAdded: 0,
          framesClaimed: 0,
          conflicts: 0,
          takesAdded: 0,
          takesSkipped: 0,
          propsAdded: 0,
          propsUpdated: 0,
        };
        this.report = report;
        return report;
      } finally {
        this.busy = false;
      }
    },

    /** 重试上一次合并（包仍保留，无需重新选文件） */
    async retryMerge(): Promise<MergeReport> {
      if (!this.parsed) return this.rejectReport('没有可重试的离线包');
      return this.confirmMerge();
    },

    rejectReport(reason: string): MergeReport {
      const pkg = this.parsed;
      const report: MergeReport = {
        ok: false,
        rejected: true,
        rejectReason: reason,
        packageId: pkg?.packageId ?? '',
        deviceSerial: pkg?.deviceSerial ?? '',
        group: pkg?.group ?? this.group,
        exportedAt: pkg?.exportedAt ?? 0,
        shotsAdded: 0,
        shotsMatched: 0,
        framesAdded: 0,
        framesClaimed: 0,
        conflicts: 0,
        takesAdded: 0,
        takesSkipped: 0,
        propsAdded: 0,
        propsUpdated: 0,
      };
      this.report = report;
      this.error = reason;
      return report;
    },

    /**
     * 合并主流程：
     *  快照 → 镜头认领/新建 → 帧按镜号+帧槽认领/新增 → 冲突留双方值
     *  → 道具认领 → 实拍按包+设备去重 → 批次留痕
     * 任何一步抛错：用快照恢复合并前内容，允许重试。
     */
    async runMerge(pkg: OfflinePackage): Promise<MergeReport> {
      // 包级幂等：同一 packageId 已导入过 → 整批拒绝（不回退、不重复）
      const existed = await api.findMergeBatch(pkg.packageId);
      if (existed) {
        return {
          ok: false,
          rejected: true,
          rejectReason: `该离线包（${GROUP_LABELS[pkg.group]} ${pkg.deviceSerial}）已于 ${new Date(existed.importedAt).toLocaleString()} 导入，请勿重复导入`,
          packageId: pkg.packageId,
          deviceSerial: pkg.deviceSerial,
          group: pkg.group,
          exportedAt: pkg.exportedAt,
          shotsAdded: 0,
          shotsMatched: 0,
          framesAdded: 0,
          framesClaimed: 0,
          conflicts: 0,
          takesAdded: 0,
          takesSkipped: 0,
          propsAdded: 0,
          propsUpdated: 0,
        };
      }

      // 0. 合并前快照（写入失败据此恢复）
      const snap = await api.exportSnapshot();

      try {
        // 1. 镜头：按镜号认领，不存在则新建（进度快照归零，不回退已确认进度）
        const shotMerge = mergeShots(snap.shots, pkg.shots);
        for (const shot of shotMerge.newShots) {
          const id = await api.addShot(toPlain(shot));
          shotMerge.localIdByCode.set(shot.code, id);
        }

        // 2. 帧：按镜号 + 帧槽认领，新增帧接在原顺序后
        let framesAdded = 0;
        let framesClaimed = 0;
        const appendedFrames: FrameEntry[] = [];
        const conflictDescs: FrameConflictDesc[] = [];
        for (const incShot of pkg.shots) {
          const localId = shotMerge.localIdByCode.get(incShot.code);
          if (typeof localId !== 'number') continue;
          const localRows = snap.frames.filter((f) => f.shotId === localId);
          const incRows = pkg.frames.filter((f) => f.shotId === incShot.id);
          const res = mergeShotFrames(incShot.code, localId, localRows, incRows);
          framesAdded += res.added;
          framesClaimed += res.claimed;
          appendedFrames.push(...res.rows.filter((f) => typeof f.id !== 'number'));
          conflictDescs.push(...res.conflicts);
        }
        if (appendedFrames.length) await api.bulkAddFrames(appendedFrames);

        // 3. 冲突：留双方值，等场记选定后再更新当前镜头
        let conflicts = 0;
        for (const desc of conflictDescs) {
          const existedPending = await api.findPendingConflict(desc.shotCode, desc.frameNo);
          if (existedPending && typeof existedPending.id === 'number') {
            await api.updateConflict(existedPending.id, {
              fields: desc.fields,
              local: toPlain(desc.local),
              incoming: toPlain(desc.incoming),
              status: 'pending',
              resolution: undefined,
              resolvedAt: undefined,
            });
          } else {
            await api.addConflict({
              shotCode: desc.shotCode,
              frameNo: desc.frameNo,
              fields: desc.fields,
              local: toPlain(desc.local),
              incoming: toPlain(desc.incoming),
              status: 'pending',
              createdAt: Date.now(),
            });
          }
          conflicts += 1;
        }

        // 4. 道具：按镜号 + 帧区间 + 道具名认领，新值较新则更新
        let propsAdded = 0;
        let propsUpdated = 0;
        const propRows: PropState[] = [];
        for (const incShot of pkg.shots) {
          const localId = shotMerge.localIdByCode.get(incShot.code);
          if (typeof localId !== 'number') continue;
          const localProps = snap.props.filter((p) => p.shotId === localId);
          const incProps = pkg.props.filter((p) => p.shotId === incShot.id);
          const res = mergeProps(localProps, incProps, localId);
          propsAdded += res.added;
          propsUpdated += res.updated;
          propRows.push(...res.rows);
        }
        if (propRows.length) await api.bulkPutProps(propRows);

        // 5. 镜头帧区间联动：新增帧后重算 endFrame / durationSec（不动进度与状态）
        const localShotById = new Map<number, Shot>();
        for (const s of snap.shots) {
          if (typeof s.id === 'number') localShotById.set(s.id, s);
        }
        for (const shot of shotMerge.newShots) {
          const id = shotMerge.localIdByCode.get(shot.code);
          if (typeof id === 'number') localShotById.set(id, { ...shot, id });
        }
        for (const incShot of pkg.shots) {
          const localId = shotMerge.localIdByCode.get(incShot.code);
          if (typeof localId !== 'number') continue;
          const localShot = localShotById.get(localId);
          if (!localShot) continue;
          const appendedForShot = appendedFrames.filter((f) => f.shotId === localId);
          const count = snap.frames.filter((f) => f.shotId === localId).length + appendedForShot.length;
          if (count <= 0) continue;
          const endFrame = localShot.startFrame + count - 1;
          const durationSec = Math.round((count / (localShot.fps || 24)) * 1000) / 1000;
          await api.updateShot(localId, { endFrame, durationSec });
        }

        // 6. 实拍记录：按包 + 设备序号去重，只做并集（不删除、不回退进度）
        const localTakes = snap.takes;
        const takeMerge = mergeTakes(localTakes, pkg.takes, pkg);
        // 实拍的 shotId 是对方设备上的 id，按镜号改挂本地镜头
        const takeRows: TakeLog[] = [];
        for (const t of takeMerge.rows) {
          const localId = shotMerge.localIdByCode.get(t.shotCode);
          if (typeof localId !== 'number') continue;
          takeRows.push({ ...t, shotId: localId });
        }
        if (takeRows.length) await api.bulkAddTakes(takeRows);

        // 7. 批次留痕
        const batch: MergeBatch = {
          packageId: pkg.packageId,
          deviceSerial: pkg.deviceSerial,
          group: pkg.group,
          exportedAt: pkg.exportedAt,
          importedAt: Date.now(),
          shotsAdded: shotMerge.added,
          framesAdded,
          framesClaimed,
          takesAdded: takeRows.length,
          takesSkipped: takeMerge.skipped,
        };
        await api.addMergeBatch(toPlain(batch));

        return {
          ok: true,
          rejected: false,
          packageId: pkg.packageId,
          deviceSerial: pkg.deviceSerial,
          group: pkg.group,
          exportedAt: pkg.exportedAt,
          shotsAdded: shotMerge.added,
          shotsMatched: shotMerge.matched,
          framesAdded,
          framesClaimed,
          conflicts,
          takesAdded: takeRows.length,
          takesSkipped: takeMerge.skipped,
          propsAdded,
          propsUpdated,
          batch,
        };
      } catch (e) {
        // 写入失败：恢复合并前内容，包保留，允许重试
        await api.restoreSnapshot(snap);
        throw e;
      }
    },

    /* ---------------- 场记选定冲突 ---------------- */

    async loadConflicts() {
      this.conflicts = await api.listConflicts();
    },

    async resolveConflict(id: number, resolution: 'local' | 'incoming') {
      const conflict = this.conflicts.find((c) => c.id === id);
      if (!conflict || conflict.status !== 'pending') return;
      const chosen = resolution === 'local' ? conflict.local : conflict.incoming;
      // 按镜号 + 帧槽找到当前镜头帧，更新冲突字段（场记选定后才更新当前镜头）
      const shots = await api.listShots();
      const shot = shots.find((s) => s.code === conflict.shotCode);
      if (shot && typeof shot.id === 'number') {
        const frame = await api.findFrame(shot.id, conflict.frameNo);
        if (frame && typeof frame.id === 'number') {
          const patch: Partial<FrameEntry> = {};
          for (const field of conflict.fields) {
            (patch as Record<string, unknown>)[field] = (chosen as Record<string, unknown>)[field];
          }
          patch.updatedAt = Date.now();
          await api.updateFrame(frame.id, toPlain(patch));
        }
      }
      await api.updateConflict(id, {
        status: 'resolved',
        resolution,
        resolvedAt: Date.now(),
      });
      await this.loadConflicts();
    },

    async loadBatches() {
      this.batches = await api.listMergeBatches();
    },
  },
});

function formatBytes(n: number): string {
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
