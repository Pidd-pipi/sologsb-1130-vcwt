/**
 * 离线回棚合并：两个整包导入 → 容量预演 → 合并提交；
 * 容量不足整批拒绝且保留两包；写入失败已由引擎恢复，可直接重试。
 * 冲突挂起时当前镜头不动，场记在本页选定后才更新对应帧。
 */
import { computed, ref } from 'vue';
import {
  mergeOfflinePackages,
  resolveConflict as resolveConflictEngine,
} from '../services/mergeEngine';
import { readPackageFile } from '../services/offlinePackage';
import type {
  CapacityPreview,
  ConflictSide,
  MergePlan,
  OfflineGroup,
  OfflinePackage,
  PendingConflict,
  ShotMergeStat,
} from '../types/offline';
import { MergeError } from '../types/offline';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';

export type MergeStatus = 'idle' | 'ready' | 'rejected' | 'success' | 'failed';

export interface MergeNotice {
  type: 'info' | 'success' | 'error' | 'warning';
  text: string;
}

export function useOfflineMerge() {
  const shotStore = useShotStore();
  const frameStore = useFrameStore();

  const studioPkg = ref<OfflinePackage | null>(null);
  const locationPkg = ref<OfflinePackage | null>(null);
  const studioFileName = ref('');
  const locationFileName = ref('');

  const status = ref<MergeStatus>('idle');
  const notice = ref<MergeNotice | null>(null);
  const plan = ref<MergePlan | null>(null);
  const conflicts = ref<PendingConflict[]>([]);
  const merging = ref(false);

  const canMerge = computed(() => !!studioPkg.value && !!locationPkg.value && !merging.value);

  async function importPackage(group: OfflineGroup, file: File): Promise<void> {
    try {
      const pkg = await readPackageFile(file, group);
      if (group === '棚内') {
        studioPkg.value = pkg;
        studioFileName.value = file.name;
      } else {
        locationPkg.value = pkg;
        locationFileName.value = file.name;
      }
      status.value = studioPkg.value && locationPkg.value ? 'ready' : 'idle';
      plan.value = null;
      setNotice('info', `已读取${group}包：${pkg.meta.deviceSeq} 号机，${pkg.frames.length} 帧 / ${pkg.takes.length} 条实拍`);
    } catch (e) {
      setNotice('error', e instanceof MergeError ? e.message : '读取离线包失败');
    }
  }

  function clearPackages(): void {
    studioPkg.value = null;
    locationPkg.value = null;
    studioFileName.value = '';
    locationFileName.value = '';
    plan.value = null;
    status.value = 'idle';
    setNotice('info', '两个离线包已清空，可重新选择文件');
  }

  /** 保留两个包仅改提示，便于换包或重试 */
  function setNotice(type: MergeNotice['type'], text: string): void {
    notice.value = { type, text };
  }

  async function runMerge(): Promise<void> {
    if (!studioPkg.value || !locationPkg.value) {
      setNotice('warning', '请先导入棚内、外景两个离线包');
      return;
    }
    merging.value = true;
    try {
      const result = await mergeOfflinePackages(studioPkg.value, locationPkg.value);
      plan.value = result;
      status.value = 'success';
      await Promise.all([shotStore.load(), loadConflicts()]);
      if (frameStore.shotId !== null) await frameStore.loadForShot(frameStore.shotId);
      setNotice(
        result.totalConflicts > 0 ? 'warning' : 'success',
        `合并完成：新增帧 ${result.totalAppendedFrames}、实拍记录 ${result.totalTakesAdded} 条、待裁决冲突 ${result.totalConflicts} 处`,
      );
    } catch (e) {
      if (e instanceof MergeError && e.code === 'capacity') {
        // 整批拒绝：两个包保持已导入状态，不做任何数据改动
        status.value = 'rejected';
        plan.value = {
          preview: e.detail as CapacityPreview,
          stats: [],
          totalAppendedFrames: 0,
          totalTakesAdded: 0,
          totalConflicts: 0,
        };
        setNotice('error', e.message);
      } else if (e instanceof MergeError && e.code === 'write-failed') {
        // 引擎已恢复合并前内容，包仍保留，允许原样重试
        status.value = 'failed';
        setNotice('error', e.message);
      } else {
        status.value = 'failed';
        setNotice('error', e instanceof Error ? e.message : '合并失败');
      }
    } finally {
      merging.value = false;
    }
  }

  async function loadConflicts(): Promise<void> {
    conflicts.value = await api.listConflicts();
  }

  const pendingConflicts = computed(() => conflicts.value.filter((c) => c.status === 'pending'));
  const resolvedConflicts = computed(() => conflicts.value.filter((c) => c.status === 'resolved'));

  async function chooseSide(conflict: PendingConflict, side: ConflictSide): Promise<void> {
    if (typeof conflict.id !== 'number') return;
    try {
      await resolveConflictEngine(conflict.id, side);
      await loadConflicts();
      if (frameStore.shotId === conflict.shotId) await frameStore.loadForShot(conflict.shotId);
      setNotice('success', `镜号 ${conflict.shotCode} 第 ${conflict.slot} 帧已采用${side === 'studio' ? '棚内' : '外景'}值并更新当前镜头`);
    } catch (e) {
      setNotice('error', e instanceof Error ? e.message : '裁决失败');
    }
  }

  async function confirmTake(id: number | undefined): Promise<void> {
    if (typeof id !== 'number') return;
    await api.confirmTake(id);
    setNotice('success', '该条实拍记录已确认，后续离线合并不再回退此进度');
  }

  function statByCode(code: string): ShotMergeStat | undefined {
    return plan.value?.stats.find((s) => s.shotCode === code);
  }

  return {
    studioPkg,
    locationPkg,
    studioFileName,
    locationFileName,
    status,
    notice,
    plan,
    conflicts,
    pendingConflicts,
    resolvedConflicts,
    merging,
    canMerge,
    importPackage,
    clearPackages,
    runMerge,
    loadConflicts,
    chooseSide,
    confirmTake,
    statByCode,
  };
}
