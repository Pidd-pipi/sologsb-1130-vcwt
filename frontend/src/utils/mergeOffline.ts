/**
 * 离线回棚合并引擎（纯函数 + 容量预演）。
 *
 * 规则：
 *  1. 按镜号（Shot.code）+ 帧槽（frameNo）认领帧条目，不认领对方设备上的自增 id；
 *  2. 认领不上的帧（新帧）接在原顺序之后，帧槽向后顺延；
 *  3. 同一帧的曝光（曝光时间/光圈/ISO/快门角度）或道具位移两边都有新值时，
 *     不覆盖当前镜头，留双方值生成冲突，等场记选定后再更新；
 *  4. 实拍记录按包 + 设备序号去重，只做并集，不删除、不回退已确认进度；
 *  5. 合并前按浏览器剩余空间预演，容量不足则整批拒绝、两个包都保留原样。
 */
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { frameUid } from './frameMath';
import {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  type OfflinePackage,
  type PackageGroup,
  type StoragePreflight,
} from '../types/package';

export { frameUid };
export { PACKAGE_FORMAT, PACKAGE_VERSION };
export type { OfflinePackage, PackageGroup };

/** 冲突字段：曝光四件套 + 道具位移 */
export const CONFLICT_FIELDS = ['exposureSec', 'aperture', 'iso', 'shutterAngle', 'propOffsetMm'] as const;

export const FIELD_LABELS: Record<string, string> = {
  exposureSec: '曝光时间',
  aperture: '光圈',
  iso: 'ISO',
  shutterAngle: '快门角度',
  propOffsetMm: '道具位移',
};

/** 包内数据相对 JSON 体积的膨胀系数（结构化克隆 + 索引开销） */
const STORAGE_EXPANSION = 3;
/** 预留余量：2MB */
const STORAGE_MARGIN = 2 * 1024 * 1024;

export function createPackageId(): string {
  return `pkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDeviceSerial(): string {
  return `dev_${Math.random().toString(36).slice(2, 10)}`;
}

/* ---------------- 包校验与解析 ---------------- */

/** 校验包结构，返回错误信息；通过返回 null */
export function validatePackage(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return '包内容不是有效的 JSON 对象';
  const p = raw as Record<string, unknown>;
  if (p.format !== PACKAGE_FORMAT) return '无法识别的包格式（format 不匹配，可能不是本系统的离线包）';
  if (p.version !== PACKAGE_VERSION) return `包版本不受支持：v${String(p.version)}，请用对应版本的系统导入`;
  if (typeof p.packageId !== 'string' || !p.packageId) return '缺少包标识 packageId';
  if (typeof p.deviceSerial !== 'string' || !p.deviceSerial) return '缺少设备序号 deviceSerial';
  if (p.group !== 'studio' && p.group !== 'location') return '缺少分组 group（应为棚内/外景）';
  if (!Number.isFinite(p.exportedAt)) return '缺少导出时间戳 exportedAt';
  if (!Array.isArray(p.shots)) return 'shots 不是数组';
  if (!Array.isArray(p.frames)) return 'frames 不是数组';
  if (!Array.isArray(p.props)) return 'props 不是数组';
  if (!Array.isArray(p.takes)) return 'takes 不是数组';
  return null;
}

export function parsePackageText(text: string): { pkg?: OfflinePackage; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'JSON 解析失败，请检查文件内容是否完整' };
  }
  const err = validatePackage(raw);
  if (err) return { error: err };
  return { pkg: raw as OfflinePackage };
}

/* ---------------- 容量预演 ---------------- */

export async function storagePreflight(pkg: OfflinePackage): Promise<StoragePreflight> {
  const json = JSON.stringify(pkg);
  const bytes = new Blob([json]).size;
  const needed = bytes * STORAGE_EXPANSION + STORAGE_MARGIN;
  let quota = 0;
  let usage = 0;
  let supported = false;
  try {
    const nav = navigator as Navigator & { storage?: StorageManager };
    if (nav.storage?.estimate) {
      const est = await nav.storage.estimate();
      quota = est.quota ?? 0;
      usage = est.usage ?? 0;
      supported = quota > 0;
    }
  } catch {
    supported = false;
  }
  const remaining = Math.max(0, quota - usage);
  // 浏览器不支持 estimate 时不拦写入（写入失败仍有快照回滚兜底）
  const ok = supported ? remaining >= needed : true;
  return { bytes, quota, usage, remaining, needed, ok, supported };
}

/* ---------------- 帧：按镜号 + 帧槽认领 ---------------- */

export interface FrameConflictDesc {
  shotCode: string;
  frameNo: number;
  fields: string[];
  local: FrameEntry;
  incoming: FrameEntry;
}

export interface ShotFramesMerge {
  /** 合并后该镜头的全部帧（本地原样 + 新增顺延） */
  rows: FrameEntry[];
  /** 新增帧数 */
  added: number;
  /** 认领帧数 */
  claimed: number;
  /** 冲突描述 */
  conflicts: FrameConflictDesc[];
}

/**
 * 合并单个镜头的帧条目。
 * @param shotCode 镜号（认领键）
 * @param localShotId 本地镜头 id（新增帧挂到本地镜头下）
 * @param localFrames 本地该镜头帧（已按 frameNo 排序）
 * @param incomingFrames 包内该镜头帧
 */
export function mergeShotFrames(
  shotCode: string,
  localShotId: number,
  localFrames: FrameEntry[],
  incomingFrames: FrameEntry[],
): ShotFramesMerge {
  const local = localFrames.slice().sort((a, b) => a.frameNo - b.frameNo);
  const bySlot = new Map<number, FrameEntry>();
  for (const f of local) bySlot.set(f.frameNo, f);

  const conflicts: FrameConflictDesc[] = [];
  const appended: FrameEntry[] = [];
  let added = 0;
  let claimed = 0;
  let nextSlot = local.reduce((m, f) => Math.max(m, f.frameNo), 0);

  const incomingSorted = incomingFrames.slice().sort((a, b) => a.frameNo - b.frameNo);
  for (const inc of incomingSorted) {
    const exist = bySlot.get(inc.frameNo);
    if (exist) {
      // 按帧槽认领：本地帧原样保留，仅登记冲突，不覆盖当前镜头
      claimed += 1;
      const fields = conflictFieldsOf(exist, inc);
      if (fields.length) {
        conflicts.push({
          shotCode,
          frameNo: inc.frameNo,
          fields,
          local: { ...exist },
          incoming: { ...inc, shotId: localShotId },
        });
      }
    } else {
      // 新帧接在原顺序后，帧槽顺延
      nextSlot += 1;
      added += 1;
      appended.push({
        ...inc,
        id: undefined,
        shotId: localShotId,
        frameNo: nextSlot,
        uid: frameUid(shotCode, nextSlot),
      });
    }
  }

  return { rows: [...local, ...appended], added, claimed, conflicts };
}

/** 两边都有新值的字段：数值不等即视为冲突（曝光四件套 + 道具位移） */
export function conflictFieldsOf(local: FrameEntry, incoming: FrameEntry): string[] {
  const fields: string[] = [];
  const l = local as unknown as Record<string, unknown>;
  const i = incoming as unknown as Record<string, unknown>;
  for (const f of CONFLICT_FIELDS) {
    if (valuesDiffer(l[f], i[f])) fields.push(f);
  }
  return fields;
}

/** 数值比较：任一侧缺字段（非有限数）视为该侧无新值，不构成冲突（两边都有新值才留双方值） */
function valuesDiffer(a: unknown, b: unknown): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return na !== nb;
}

/* ---------------- 实拍记录：按包 + 设备序号去重 ---------------- */

export interface TakeMergeResult {
  /** 待写入的新增实拍（已盖包印） */
  rows: TakeLog[];
  added: number;
  skipped: number;
}

/** 实拍记录去重键：设备序号 + 日期 + 镜号 + 张数（同一设备的同一条记录不重复计入进度） */
export function takeDedupKey(t: TakeLog): string {
  return `${t.deviceSerial ?? ''}|${t.date}|${t.shotCode}|${t.takenFrames}|${t.wastedFrames}`;
}

export function mergeTakes(localTakes: TakeLog[], incomingTakes: TakeLog[], pkg: OfflinePackage): TakeMergeResult {
  const seen = new Set(localTakes.map((t) => takeDedupKey(t)));
  const rows: TakeLog[] = [];
  let skipped = 0;
  for (const inc of incomingTakes) {
    // 设备序号是创建设备的稳定标识，导入时保留；packageId 记录把它带进来的包
    const stamped: TakeLog = {
      ...inc,
      packageId: pkg.packageId,
      deviceSerial: inc.deviceSerial ?? pkg.deviceSerial,
    };
    const key = takeDedupKey(stamped);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    rows.push({ ...stamped, id: undefined });
  }
  return { rows, added: rows.length, skipped };
}

/* ---------------- 道具状态：按镜号 + 帧区间 + 道具名认领 ---------------- */

export interface PropMergeResult {
  /** 待写入（新增或更新）的道具行 */
  rows: PropState[];
  added: number;
  updated: number;
}

function propKey(p: PropState): string {
  return `${p.shotId}|${p.name}|${p.fromFrame}|${p.toFrame}`;
}

export function mergeProps(localProps: PropState[], incomingProps: PropState[], localShotId: number): PropMergeResult {
  const byKey = new Map<string, PropState>();
  for (const p of localProps) byKey.set(propKey(p), p);
  const rows: PropState[] = [];
  let added = 0;
  let updated = 0;
  for (const inc of incomingProps) {
    const stamped: PropState = { ...inc, shotId: localShotId };
    const exist = byKey.get(propKey(stamped));
    if (exist) {
      if ((stamped.updatedAt ?? 0) > (exist.updatedAt ?? 0)) {
        rows.push({ ...stamped, id: exist.id });
        updated += 1;
      }
    } else {
      rows.push({ ...stamped, id: undefined });
      added += 1;
      byKey.set(propKey(stamped), stamped);
    }
  }
  return { rows, added, updated };
}

/* ---------------- 镜头：按镜号认领，不存在则新建 ---------------- */

export interface ShotMergeResult {
  /** 镜号 → 本地镜头 id */
  localIdByCode: Map<string, number>;
  /** 新建镜头（待写入，已剥离对方 id） */
  newShots: Shot[];
  added: number;
  matched: number;
}

export function mergeShots(localShots: Shot[], incomingShots: Shot[]): ShotMergeResult {
  const localIdByCode = new Map<string, number>();
  for (const s of localShots) {
    if (typeof s.id === 'number') localIdByCode.set(s.code, s.id);
  }
  const newShots: Shot[] = [];
  let added = 0;
  let matched = 0;
  for (const inc of incomingShots) {
    if (localIdByCode.has(inc.code)) {
      matched += 1;
    } else {
      // 新建镜头：进度快照归零，不回退已确认进度
      const fresh: Shot = { ...inc, id: undefined, progressPercent: 0, status: '未开机' };
      newShots.push(fresh);
      added += 1;
    }
  }
  return { localIdByCode, newShots, added, matched };
}
