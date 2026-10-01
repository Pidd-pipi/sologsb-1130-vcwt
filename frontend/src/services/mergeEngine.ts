/**
 * 离线回棚合并引擎。
 *
 * 规则：
 * 1. 帧按「镜号 + 帧槽/稳定帧标识」认领：本机已有的帧就地合并；
 *    新增帧接在原顺序之后（同槽/同 key 的双方内容合成同一帧）。
 * 2. 同一帧的曝光组、道具位移、实拍张数，两边都有新值且互不相同 →
 *    双方值都存入 conflicts 表，当前镜头保持原值，等场记在页面选定后再更新。
 * 3. 实拍记录按「来源包 + 设备序号 + 记录序号」去重；
 *    已确认进度只升不降，晚到的包不能把确认过的百分比压回去。
 * 4. 提交前按 navigator.storage.estimate 预演容量，不足整批拒绝
 *    （不做任何写入，调用方继续保留两个包）。
 * 5. 提交为单事务；事务外再用整库快照兜底，写入失败恢复到合并前内容，
 *    快照恢复后可以原样重试。
 */
import { db, toPlain } from '../db';
import * as api from '../db/api';
import {
  MergeError,
  type CapacityPreview,
  type ConflictKind,
  type ConflictSide,
  type MergePlan,
  type OfflineFramePayload,
  type OfflinePackage,
  type PendingConflict,
  type ShotMergeStat,
} from '../types/offline';
import type { ExposureBundle, FrameEntry, ShotCount } from '../types/frame';
import { createEmptyFrame } from '../types/frame';
import type { Shot } from '../types/shot';
import type { TakeLog } from '../types/take';
import { buildTakeDedupeKey } from '../types/take';
import { buildFrameKey } from '../utils/frameKey';

const STORAGE_SAFETY_FACTOR = 1.35;

type SideName = 'studio' | 'location';

interface SideFrame {
  studio?: OfflineFramePayload;
  location?: OfflineFramePayload;
}

interface FrameConflictSpec {
  shotId: number;
  shotCode: string;
  frameKey: string;
  slot: number;
  kind: ConflictKind;
  baseValue: string;
  studioValue: string;
  locationValue: string;
  studioUpdatedAt: number;
  locationUpdatedAt: number;
  createdAt: number;
}

interface ShotMergeWork {
  shotCode: string;
  shotExisted: boolean;
  /** 库内不存在时带负的临时 id，提交时替换为真实 id */
  baseShot: Shot;
  /** 本机原有帧（含 id，按原 frameNo 顺序） */
  baseFrames: FrameEntry[];
  /** key → 本机帧行 */
  localByKey: Map<string, FrameEntry>;
  /** 双方对同一镜号的帧数据，key = frameKey */
  sidesByKey: Map<string, SideFrame>;
  /** 有序槽位（新增帧排序用） */
  slotsByKey: Map<string, number>;
  /** 合并后顺序：先原顺序，再新增帧 */
  resultFrames: FrameEntry[];
  /** 被规整丢弃的重复 frameKey 行 id，提交时删除 */
  staleFrameIds: number[];
  conflictSpecs: FrameConflictSpec[];
  stat: ShotMergeStat;
}

interface PreparedPlan {
  /** 新建镜头（库内不存在，提交后才能拿到 id） */
  newShots: Shot[];
  /** 原有镜头整行覆盖（帧区间已按合并结果重算） */
  updatedShots: Shot[];
  /** 原有帧就地合并后整行覆盖（保留 id） */
  updatedFrames: FrameEntry[];
  /** 历史重复 frameKey 行：提交时删除 */
  staleFrameIds: number[];
  /** 新增帧（无 id，提交时逐条 add） */
  newFrames: FrameEntry[];
  /** 新帧 frameKey → 镜号（提交时替换临时镜头 id 用） */
  newFrameShotCode: Map<string, string>;
  /** 冲突规格（frameId 在新帧入库后补） */
  conflictSpecs: FrameConflictSpec[];
  /** 新增实拍（shotId 已解析） */
  newTakes: TakeLog[];
  stats: ShotMergeStat[];
}

/* ---------------- 纯函数：曝光取值 ---------------- */

function bundleOf(frame: { exposureSec: number; aperture: number; iso: number; shutterAngle: number; lighting: string }): ExposureBundle {
  return {
    exposureSec: frame.exposureSec,
    aperture: frame.aperture,
    iso: frame.iso,
    shutterAngle: frame.shutterAngle,
    lighting: frame.lighting,
  };
}

function bundleFromSide(payload: OfflineFramePayload | undefined, base: ExposureBundle): ExposureBundle {
  return {
    exposureSec: typeof payload?.exposureSec === 'number' ? payload.exposureSec : base.exposureSec,
    aperture: typeof payload?.aperture === 'number' ? payload.aperture : base.aperture,
    iso: typeof payload?.iso === 'number' ? payload.iso : base.iso,
    shutterAngle: typeof payload?.shutterAngle === 'number' ? payload.shutterAngle : base.shutterAngle,
    lighting: typeof payload?.lighting === 'string' ? payload.lighting : base.lighting,
  };
}

function bundlesEqual(a: ExposureBundle, b: ExposureBundle): boolean {
  return (
    a.exposureSec === b.exposureSec &&
    a.aperture === b.aperture &&
    a.iso === b.iso &&
    a.shutterAngle === b.shutterAngle &&
    a.lighting === b.lighting
  );
}

/* ---------------- 预演（纯内存，不写库） ---------------- */

function codeKey(code: string): string {
  return code.trim().toUpperCase();
}

export async function planMerge(studioPkg: OfflinePackage, locationPkg: OfflinePackage): Promise<PreparedPlan> {
  const now = Date.now();
  const localShots = await api.listAllShots();
  const localFrames = await api.listAllFrames();
  const localTakes = await api.listAllTakes();

  const shotByCode = new Map<string, Shot>();
  for (const shot of localShots) shotByCode.set(codeKey(shot.code), shot);

  const framesByShot = new Map<number, FrameEntry[]>();
  for (const frame of localFrames) {
    const list = framesByShot.get(frame.shotId) ?? [];
    list.push(frame);
    framesByShot.set(frame.shotId, list);
  }
  for (const list of framesByShot.values()) list.sort((a, b) => a.frameNo - b.frameNo);

  const packages: Array<{ side: SideName; pkg: OfflinePackage }> = [
    { side: 'studio', pkg: studioPkg },
    { side: 'location', pkg: locationPkg },
  ];

  // 镜号集合：本机 + 两个包
  const allCodes = new Set<string>();
  localShots.forEach((s) => allCodes.add(codeKey(s.code)));
  for (const { pkg } of packages) {
    pkg.frames.forEach((f) => allCodes.add(codeKey(f.shotCode)));
    pkg.takes.forEach((t) => allCodes.add(codeKey(t.shotCode)));
    pkg.shots.forEach((s) => allCodes.add(codeKey(s.code)));
  }

  const works = new Map<string, ShotMergeWork>();
  let newShotSeq = 0;

  for (const codeUpper of allCodes) {
    const existingShot = shotByCode.get(codeUpper);
    let baseShot: Shot;
    let shotExisted: boolean;
    if (existingShot) {
      baseShot = existingShot;
      shotExisted = true;
    } else {
      // 新镜头：优先采用棚内包元信息，其次外景包
      const studioMeta = studioPkg.shots.find((s) => codeKey(s.code) === codeUpper);
      const locationMeta = locationPkg.shots.find((s) => codeKey(s.code) === codeUpper);
      const meta = studioMeta ?? locationMeta;
      if (!meta) continue; // 两个包都没有镜头元信息，跳过（实拍/帧无可归属）
      newShotSeq -= 1;
      baseShot = {
        id: newShotSeq, // 临时负 id，提交入库后替换
        code: meta.code,
        sceneName: meta.sceneName,
        fps: meta.fps,
        durationSec: meta.durationSec,
        startFrame: meta.startFrame,
        endFrame: meta.endFrame,
        status: '未开机',
        owner: '',
        progressPercent: 0,
        createdAt: now,
        updatedAt: now,
      };
      shotExisted = false;
    }

    // 本机帧按 frameNo 排序；历史数据缺 key 或同 key 重复时做一次规整，
    // 缺 key 按「镜号 + 槽位」补确定性 key（与离线设备一致），重复保留更新时间最新者。
    const rawBase = existingShot ? (framesByShot.get(existingShot.id ?? -1) ?? []) : [];
    const baseFrames: FrameEntry[] = [];
    const baseIndexByKey = new Map<string, number>();
    rawBase
      .slice()
      .sort((a, b) => a.frameNo - b.frameNo)
      .forEach((row, idx) => {
        const f: FrameEntry = {
          ...toPlain(row),
          frameKey: row.frameKey || buildFrameKey(existingShot?.code ?? '', idx + 1),
        };
        const existingIndex = baseIndexByKey.get(f.frameKey);
        if (existingIndex === undefined) {
          baseIndexByKey.set(f.frameKey, baseFrames.length);
          baseFrames.push(f);
        } else if (f.updatedAt > baseFrames[existingIndex].updatedAt) {
          if (typeof baseFrames[existingIndex].id === 'number') staleFrameIds.push(baseFrames[existingIndex].id!);
          baseFrames[existingIndex] = f;
        } else if (typeof f.id === 'number') {
          staleFrameIds.push(f.id);
        }
      });
    const localByKey = new Map<string, FrameEntry>();
    baseFrames.forEach((f) => localByKey.set(f.frameKey, f));

    const sidesByKey = new Map<string, SideFrame>();
    const slotsByKey = new Map<string, number>();
    for (const { side, pkg } of packages) {
      for (const payload of pkg.frames) {
        if (codeKey(payload.shotCode) !== codeUpper) continue;
        // 包内缺 key（旧版导出）按镜号 + 槽位补，保证两侧与本机旧帧仍能认领
        const key = payload.frameKey || buildFrameKey(payload.shotCode, payload.slot);
        const entry = sidesByKey.get(key) ?? {};
        entry[side] = payload;
        sidesByKey.set(key, entry);
        slotsByKey.set(key, payload.slot);
      }
    }

    works.set(codeUpper, {
      shotCode: baseShot.code,
      shotExisted,
      baseShot: { ...baseShot },
      baseFrames,
      localByKey,
      sidesByKey,
      slotsByKey,
      resultFrames: [],
      staleFrameIds: [],
      conflictSpecs: [],
      stat: {
        shotCode: baseShot.code,
        shotExisted,
        claimedFrames: 0,
        appendedFrames: 0,
        updatedFrames: 0,
        conflicts: 0,
        takesAdded: 0,
      },
    });
  }

  const newShots: Shot[] = [];
  const updatedShots: Shot[] = [];
  const updatedFrames: FrameEntry[] = [];
  const staleFrameIds: number[] = [];
  const newFrames: FrameEntry[] = [];
  const conflictSpecs: FrameConflictSpec[] = [];
  const newTakes: TakeLog[] = [];
  const stats: ShotMergeStat[] = [];
  const newFrameShotCode = new Map<string, string>();

  for (const work of works.values()) {
    mergeShotFrames(work, now);
    conflictSpecs.push(...work.conflictSpecs);
    staleFrameIds.push(...work.staleFrameIds);

    // 重排帧序号并重算镜头帧区间 / 时长
    const total = work.resultFrames.length;
    const fps = work.baseShot.fps || 24;
    const mergedShot: Shot = {
      ...work.baseShot,
      endFrame: work.baseShot.startFrame + total - 1,
      durationSec: Math.round((total / fps) * 1000) / 1000,
      updatedAt: now,
    };
    if (work.shotExisted) updatedShots.push(mergedShot);
    else newShots.push(mergedShot);

    for (const frame of work.resultFrames) {
      if (typeof frame.id === 'number') updatedFrames.push(frame);
      else {
        newFrames.push(frame);
        newFrameShotCode.set(frame.frameKey, codeKey(work.shotCode));
      }
    }
    stats.push(work.stat);
  }

  // 提交后 code → shotId 的映射（新镜头先入库；其 id 为合并预演时的临时负 id）
  const shotIdByCode = new Map<string, number>();
  localShots.forEach((s) => {
    if (typeof s.id === 'number') shotIdByCode.set(codeKey(s.code), s.id);
  });
  newShots.forEach((s) => {
    if (typeof s.id === 'number') shotIdByCode.set(codeKey(s.code), s.id);
  });

  /* ---------------- 实拍记录：去重 + 进度不回退 ---------------- */

  const existingDedupe = new Set(localTakes.map((t) => t.dedupeKey).filter(Boolean));
  const takenByShot = new Map<string, number>();
  const hasConfirmedByShot = new Map<string, boolean>();
  for (const take of localTakes) {
    const code = codeKey(take.shotCode);
    takenByShot.set(code, (takenByShot.get(code) ?? 0) + (take.takenFrames || 0));
    if (take.confirmed) hasConfirmedByShot.set(code, true);
  }

  const incomingByKey = new Map<string, TakeLog>();
  for (const { pkg } of packages) {
    for (const payload of pkg.takes) {
      const codeUpper = codeKey(payload.shotCode);
      if (!works.has(codeUpper)) continue; // 无镜头可归属，丢弃
      const originPkg = payload.originPackageId || pkg.meta.packageId;
      const dedupeKey = buildTakeDedupeKey(originPkg, payload.deviceSeq, payload.takeSeq);
      if (existingDedupe.has(dedupeKey) || incomingByKey.has(dedupeKey)) continue;

      const placeholderId = shotIdByCode.get(codeUpper);
      if (typeof placeholderId !== 'number') continue; // 无镜头可归属，丢弃
      const row: TakeLog = {
        date: payload.date,
        shotCode: payload.shotCode,
        shotId: placeholderId,
        takenFrames: payload.takenFrames,
        wastedFrames: payload.wastedFrames,
        remainingFrames: 0,
        percent: 0,
        deviceSeq: payload.deviceSeq,
        takeSeq: payload.takeSeq,
        packageId: originPkg,
        dedupeKey,
        confirmed: payload.confirmed,
        updatedAt: payload.updatedAt,
      };
      incomingByKey.set(dedupeKey, row);
      if (payload.confirmed) hasConfirmedByShot.set(codeUpper, true);
    }
  }

  for (const row of incomingByKey.values()) {
    const codeUpper = codeKey(row.shotCode);
    takenByShot.set(codeUpper, (takenByShot.get(codeUpper) ?? 0) + row.takenFrames);
    newTakes.push(row);
  }

  // 回写镜头完成百分比：有确认记录时只升不降
  for (const work of works.values()) {
    const codeUpper = codeKey(work.shotCode);
    const planned = Math.max(1, work.resultFrames.length);
    const taken = takenByShot.get(codeUpper) ?? 0;
    const percent = Math.min(100, Math.round((taken / planned) * 100));
    const hasConfirmed = hasConfirmedByShot.get(codeUpper) ?? false;
    const basePercent = work.baseShot.progressPercent || 0;
    const finalPercent = hasConfirmed ? Math.max(basePercent, percent) : percent;

    const targetShot = work.shotExisted
      ? updatedShots.find((s) => codeKey(s.code) === codeUpper)
      : newShots.find((s) => codeKey(s.code) === codeUpper);
    if (targetShot) targetShot.progressPercent = finalPercent;

    const addedHere = newTakes.filter((t) => codeKey(t.shotCode) === codeUpper);
    for (const take of addedHere) {
      take.percent = finalPercent;
      take.remainingFrames = Math.max(0, planned - taken);
    }
    work.stat.takesAdded = addedHere.length;
    work.stat.conflicts = work.conflictSpecs.length;
  }

  stats.sort((a, b) => a.shotCode.localeCompare(b.shotCode, 'zh-Hans-CN'));
  return {
    newShots,
    updatedShots,
    updatedFrames,
    staleFrameIds,
    newFrames,
    newFrameShotCode,
    conflictSpecs,
    newTakes,
    stats,
  };
}

/* ---------------- 单镜帧合并 ---------------- */

function sideNewer(payload: OfflineFramePayload | undefined, baseUpdatedAt: number): boolean {
  return !!payload && payload.updatedAt > baseUpdatedAt;
}

function mergeShotFrames(work: ShotMergeWork, now: number): void {
  const { baseFrames, sidesByKey, slotsByKey } = work;

  // 1) 原顺序：本机已有帧就地合并
  for (const base of baseFrames) {
    const sides = sidesByKey.get(base.frameKey);
    const merged: FrameEntry = { ...toPlain(base) };
    if (sides) {
      work.stat.claimedFrames += 1;
      mergeClaimedFrame(work, merged, base, sides, now);
    }
    work.resultFrames.push(merged);
  }

  // 2) 新增帧接在原顺序之后：双方都没有命中本机 key 的，按槽位/时间排序
  const newKeys: string[] = [];
  for (const key of sidesByKey.keys()) {
    if (!work.localByKey.has(key)) newKeys.push(key);
  }
  newKeys.sort((a, b) => {
    const sa = slotsByKey.get(a) ?? 0;
    const sb = slotsByKey.get(b) ?? 0;
    if (sa !== sb) return sa - sb;
    const ta = Math.max(work.sidesByKey.get(a)?.studio?.updatedAt ?? 0, work.sidesByKey.get(a)?.location?.updatedAt ?? 0);
    const tb = Math.max(work.sidesByKey.get(b)?.studio?.updatedAt ?? 0, work.sidesByKey.get(b)?.location?.updatedAt ?? 0);
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });

  for (const key of newKeys) {
    const sides = sidesByKey.get(key)!;
    const frame = buildNewFrame(work.baseShot.id ?? 0, key, sides, now);
    work.stat.appendedFrames += 1;
    const base = createEmptyFrame(0, 0);
    base.updatedAt = 0; // 新帧没有基线值，双方都算新值
    mergeClaimedFrame(work, frame, { ...base, frameKey: key }, sides, now, true);
    work.resultFrames.push(frame);
  }

  // 帧序号重排
  work.resultFrames.forEach((frame, idx) => {
    frame.frameNo = idx + 1;
  });
  // 冲突的展示槽位在重排后回填（新增帧合并时 frameNo 还是 0）
  const frameNoByKey = new Map(work.resultFrames.map((f) => [f.frameKey, f.frameNo]));
  for (const spec of work.conflictSpecs) {
    spec.slot = frameNoByKey.get(spec.frameKey) ?? spec.slot;
  }
}

/** 把双方帧数据合并进当前帧；冲突字段保留双方值、当前帧不动 */
function mergeClaimedFrame(
  work: ShotMergeWork,
  target: FrameEntry,
  base: FrameEntry,
  sides: SideFrame,
  now: number,
  isAppended = false,
): void {
  const studio = sides.studio;
  const location = sides.location;
  const baseUpdatedAt = isAppended ? 0 : base.updatedAt;
  let latestUpdatedAt = base.updatedAt || 0;
  let touched = false;

  const studioNew = sideNewer(studio, baseUpdatedAt);
  const locationNew = sideNewer(location, baseUpdatedAt);

  /* ---- 曝光组 ---- */
  const baseBundle = bundleOf(base);
  const studioBundle = bundleFromSide(studio, baseBundle);
  const locationBundle = bundleFromSide(location, baseBundle);
  const studioExposureNew = studioNew && !bundlesEqual(studioBundle, baseBundle);
  const locationExposureNew = locationNew && !bundlesEqual(locationBundle, baseBundle);

  if (studioExposureNew && locationExposureNew && !bundlesEqual(studioBundle, locationBundle)) {
    pushConflict(work, target, 'exposure', JSON.stringify(baseBundle), JSON.stringify(studioBundle), JSON.stringify(locationBundle), studio!, location!, now);
  } else {
    const chosen = studioExposureNew ? studioBundle : locationExposureNew ? locationBundle : null;
    if (chosen) {
      target.exposureSec = chosen.exposureSec;
      target.aperture = chosen.aperture;
      target.iso = chosen.iso;
      target.shutterAngle = chosen.shutterAngle;
      target.lighting = chosen.lighting;
      touched = true;
    }
  }

  /* ---- 道具位移 ---- */
  const offsetChange = resolveScalar(
    studioNew ? studio!.propOffsetMm : undefined,
    locationNew ? location!.propOffsetMm : undefined,
    base.propOffsetMm,
  );
  if (offsetChange.conflict) {
    pushConflict(
      work,
      target,
      'offset',
      JSON.stringify(base.propOffsetMm),
      JSON.stringify(studio!.propOffsetMm),
      JSON.stringify(location!.propOffsetMm),
      studio!,
      location!,
      now,
    );
  } else if (offsetChange.value !== undefined && offsetChange.value !== base.propOffsetMm) {
    target.propOffsetMm = offsetChange.value;
    touched = true;
  }

  /* ---- 实拍张数 ---- */
  const countChange = resolveScalar(
    studioNew ? studio!.shotCount : undefined,
    locationNew ? location!.shotCount : undefined,
    base.shotCount,
  );
  if (countChange.conflict) {
    pushConflict(
      work,
      target,
      'shotCount',
      JSON.stringify(base.shotCount),
      JSON.stringify(studio!.shotCount),
      JSON.stringify(location!.shotCount),
      studio!,
      location!,
      now,
    );
  } else if (countChange.value !== undefined && countChange.value !== base.shotCount) {
    target.shotCount = countChange.value as ShotCount;
    touched = true;
  }

  /* ---- 备注：不进冲突，最后修改者胜 ---- */
  const noteWinner = lastWinner(studio, location, baseUpdatedAt, 'note');
  if (noteWinner && typeof noteWinner.note === 'string') {
    target.note = noteWinner.note;
    touched = true;
  }

  if (studio) latestUpdatedAt = Math.max(latestUpdatedAt, studio.updatedAt);
  if (location) latestUpdatedAt = Math.max(latestUpdatedAt, location.updatedAt);
  if ((touched || isAppended) && latestUpdatedAt) target.updatedAt = latestUpdatedAt;
  if (touched && !isAppended) work.stat.updatedFrames += 1;
}

interface ScalarResult<T> {
  value: T | undefined;
  conflict: boolean;
}

/** 标量字段三方裁决：双方新值不同 → 冲突；否则取唯一新值 */
function resolveScalar<T>(studioValue: T | undefined, locationValue: T | undefined, baseValue: T): ScalarResult<T> {
  const sHas = studioValue !== undefined;
  const lHas = locationValue !== undefined;
  if (sHas && lHas && studioValue !== locationValue) return { value: undefined, conflict: true };
  if (sHas) return { value: studioValue, conflict: false };
  if (lHas) return { value: locationValue, conflict: false };
  return { value: baseValue, conflict: false };
}

function lastWinner(
  studio: OfflineFramePayload | undefined,
  location: OfflineFramePayload | undefined,
  baseUpdatedAt: number,
  key: 'note',
): OfflineFramePayload | undefined {
  const s = studio && studio.updatedAt > baseUpdatedAt && studio[key] !== undefined ? studio : undefined;
  const l = location && location.updatedAt > baseUpdatedAt && location[key] !== undefined ? location : undefined;
  if (s && l) return s.updatedAt >= l.updatedAt ? s : l;
  return s ?? l;
}

function pushConflict(
  work: ShotMergeWork,
  target: FrameEntry,
  kind: ConflictKind,
  baseValue: string,
  studioValue: string,
  locationValue: string,
  studio: OfflineFramePayload,
  location: OfflineFramePayload,
  now: number,
): void {
  work.conflictSpecs.push({
    shotId: work.baseShot.id ?? 0,
    shotCode: work.shotCode,
    frameKey: target.frameKey,
    slot: target.frameNo,
    kind,
    baseValue,
    studioValue,
    locationValue,
    studioUpdatedAt: studio.updatedAt,
    locationUpdatedAt: location.updatedAt,
    createdAt: now,
  });
}

/** 双方共同带回来的新帧：以默认帧为底，字段级裁决在 mergeClaimedFrame 内完成 */
function buildNewFrame(shotId: number, frameKey: string, sides: SideFrame, now: number): FrameEntry {
  const base = createEmptyFrame(shotId, 0);
  return {
    ...base,
    frameKey,
    updatedAt: Math.max(sides.studio?.updatedAt ?? 0, sides.location?.updatedAt ?? 0, now),
  };
}

/* ---------------- 容量预演 ---------------- */

export function estimateMergeBytes(plan: PreparedPlan): number {
  const jsonBytes = (value: unknown) => new Blob([JSON.stringify(value)]).size;
  const bytes =
    plan.newShots.reduce((sum, s) => sum + jsonBytes(s), 0) +
    plan.updatedShots.reduce((sum, s) => sum + jsonBytes(s), 0) +
    plan.updatedFrames.reduce((sum, f) => sum + jsonBytes(f), 0) +
    plan.newFrames.reduce((sum, f) => sum + jsonBytes(f), 0) +
    plan.newTakes.reduce((sum, t) => sum + jsonBytes(t), 0) +
    plan.conflictSpecs.reduce((sum, c) => sum + jsonBytes(c), 0);
  return Math.ceil(bytes * STORAGE_SAFETY_FACTOR);
}

export async function previewCapacity(plan: PreparedPlan): Promise<CapacityPreview> {
  const requiredBytes = estimateMergeBytes(plan);
  const navigatorWithStorage = navigator as Navigator & {
    storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
  };
  const estimate = navigatorWithStorage.storage?.estimate
    ? await navigatorWithStorage.storage.estimate()
    : undefined;
  if (!estimate || typeof estimate.quota !== 'number') {
    return { quota: null, usage: null, available: null, requiredBytes, enough: true };
  }
  const usage = estimate.usage ?? 0;
  const available = Math.max(0, estimate.quota - usage);
  return { quota: estimate.quota, usage, available, requiredBytes, enough: available >= requiredBytes };
}

/* ---------------- 提交：快照 + 单事务 + 失败恢复 ---------------- */

export async function mergeOfflinePackages(studioPkg: OfflinePackage, locationPkg: OfflinePackage): Promise<MergePlan> {
  const prepared = await planMerge(studioPkg, locationPkg);
  const preview = await previewCapacity(prepared);
  if (!preview.enough) {
    throw new MergeError(
      'capacity',
      `浏览器剩余空间不足：本次合并约需 ${formatBytes(preview.requiredBytes)}，可用约 ${formatBytes(preview.available ?? 0)}，已整批拒绝（两个离线包均已保留）`,
      preview,
    );
  }

  // 容量确认后再拍快照，失败恢复与重试都以它为准
  const snapshot = await api.snapshotDatabase();

  try {
    const newShotIdByCode = new Map<string, number>();

    await db.transaction(
      'rw',
      db.shots,
      db.frames,
      db.takes,
      db.conflicts,
      async () => {
        // 新镜头先入库拿 id（去掉临时负 id，由自增主键分配）
        for (const shot of prepared.newShots) {
          const { id: _tempId, ...plain } = shot;
          const id = await db.shots.add(toPlain(plain));
          newShotIdByCode.set(codeKey(shot.code), id);
        }
        await api.bulkPutShots(prepared.updatedShots);

        await api.bulkPutFrames(prepared.updatedFrames);
        if (prepared.staleFrameIds.length) await db.frames.bulkDelete(prepared.staleFrameIds);

        // 新帧先把镜头临时 id 换成真实 id，再逐条入库拿 frameKey → id
        const newFrameIdByKey = new Map<string, number>();
        for (const f of prepared.newFrames) {
          let row = f;
          if (f.shotId < 0) {
            const code = prepared.newFrameShotCode.get(f.frameKey);
            const realShotId = code ? newShotIdByCode.get(code) : undefined;
            if (typeof realShotId === 'number') row = { ...f, shotId: realShotId };
          }
          const id = await db.frames.add(toPlain(row));
          newFrameIdByKey.set(f.frameKey, id);
        }

        // 实拍记录的 shotId 占位替换为真实 id
        const takesToAdd = prepared.newTakes.map((take) =>
          take.shotId < 0 ? { ...take, shotId: newShotIdByCode.get(codeKey(take.shotCode)) ?? take.shotId } : take,
        );
        await api.bulkAddTakes(takesToAdd);

        // 冲突入库（frameId 用已有 id 或新帧 id）
        const conflicts: PendingConflict[] = [];
        const updatedFrameIdByKey = new Map<string, number>();
        prepared.updatedFrames.forEach((f) => {
          if (typeof f.id === 'number') updatedFrameIdByKey.set(f.frameKey, f.id);
        });
        for (const spec of prepared.conflictSpecs) {
          const frameId = updatedFrameIdByKey.get(spec.frameKey) ?? newFrameIdByKey.get(spec.frameKey);
          if (typeof frameId !== 'number') continue;
          const shotId =
            spec.shotId > 0
              ? spec.shotId
              : (newShotIdByCode.get(codeKey(spec.shotCode)) ?? spec.shotId);
          conflicts.push({
            shotId,
            shotCode: spec.shotCode,
            frameId,
            frameKey: spec.frameKey,
            slot: spec.slot,
            kind: spec.kind,
            baseValue: spec.baseValue,
            studioValue: spec.studioValue,
            locationValue: spec.locationValue,
            studioUpdatedAt: spec.studioUpdatedAt,
            locationUpdatedAt: spec.locationUpdatedAt,
            status: 'pending',
            createdAt: spec.createdAt,
            updatedAt: spec.createdAt,
          });
        }
        await api.bulkAddConflicts(conflicts);
      },
    );
  } catch (e) {
    // 写入失败：恢复合并前内容，保留两个包由调用方重试
    try {
      await api.restoreDatabase(snapshot);
    } catch (restoreError) {
      throw new MergeError('write-failed', '合并写入失败，且自动恢复也失败，请联系技术处理', { original: e, restoreError });
    }
    throw new MergeError('write-failed', '合并写入失败，已恢复到合并前内容，可直接重试', e);
  }

  return {
    preview,
    stats: prepared.stats,
    totalAppendedFrames: prepared.newFrames.length,
    totalTakesAdded: prepared.newTakes.length,
    totalConflicts: prepared.conflictSpecs.length,
  };
}

/* ---------------- 场记裁决冲突 ---------------- */

export interface ResolvedConflictResult {
  frame: FrameEntry;
  kind: ConflictKind;
  side: ConflictSide;
}

/** 场记选定一方值后更新当前镜头对应帧，并把冲突标记为 resolved。
 *  帧行在整段帧序落库时会更换自增主键，因此以稳定 frameKey 定位，frameId 仅回退。 */
export async function resolveConflict(conflictId: number, side: ConflictSide): Promise<ResolvedConflictResult> {
  const [conflicts, frames] = await Promise.all([api.listConflicts(), api.listAllFrames()]);
  const conflict = conflicts.find((c) => c.id === conflictId);
  if (!conflict) throw new Error('冲突记录不存在');
  if (conflict.status === 'resolved') throw new Error('该冲突已经裁决');
  const frame =
    frames.find((f) => f.frameKey === conflict.frameKey) ?? frames.find((f) => f.id === conflict.frameId);
  if (!frame || typeof frame.id !== 'number') throw new Error('对应帧不存在（可能已被删除）');

  const rawValue = side === 'studio' ? conflict.studioValue : conflict.locationValue;
  const patch: Partial<FrameEntry> = {};
  if (conflict.kind === 'exposure') {
    const bundle = JSON.parse(rawValue) as ExposureBundle;
    patch.exposureSec = bundle.exposureSec;
    patch.aperture = bundle.aperture;
    patch.iso = bundle.iso;
    patch.shutterAngle = bundle.shutterAngle;
    patch.lighting = bundle.lighting;
  } else if (conflict.kind === 'offset') {
    patch.propOffsetMm = JSON.parse(rawValue) as number;
  } else {
    patch.shotCount = JSON.parse(rawValue) as ShotCount;
  }

  await db.transaction('rw', db.frames, db.conflicts, async () => {
    await db.frames.update(frame.id as number, toPlain({ ...patch, updatedAt: Date.now() }));
    await api.markConflictResolved(conflictId, side);
  });

  return { frame: { ...frame, ...patch }, kind: conflict.kind, side };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
