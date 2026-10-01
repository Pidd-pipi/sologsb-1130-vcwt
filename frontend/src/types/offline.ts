/**
 * 离线回棚合并相关模型。
 * 棚内组 / 外景组各自离线工作，整包导出，回棚后两个包一起合并进本机库。
 */
import type { ExposureBundle, ShotCount } from './frame';

/** 离线分组 */
export type OfflineGroup = '棚内' | '外景';

export const OFFLINE_GROUPS: OfflineGroup[] = ['棚内', '外景'];

/** 离线包文件格式版本，升级旧包时按版本号兼容 */
export const PACKAGE_FORMAT_VERSION = 1;
export const PACKAGE_FORMAT = 'gbstopmotion-offline';

/** 离线包头 */
export interface OfflinePackageMeta {
  /** 包 id（导出时随机生成，同一包重复导入用于实拍记录去重） */
  packageId: string;
  /** 分组：棚内 / 外景 */
  group: OfflineGroup;
  /** 设备序号（每台机器固定） */
  deviceSeq: number;
  /** 导出时间戳 */
  exportedAt: number;
  /** 格式版本 */
  formatVersion: number;
  /** 导出人备注 */
  producer: string;
}

/** 包内镜头信息（帧按镜号 + 帧槽认领，镜头本身只登记元信息） */
export interface OfflineShotPayload {
  code: string;
  sceneName: string;
  fps: number;
  durationSec: number;
  startFrame: number;
  endFrame: number;
}

/** 包内单帧数据：曝光参数、道具位移、实拍张数 */
export interface OfflineFramePayload {
  /** 镜号 */
  shotCode: string;
  /** 帧槽：该帧在原设备帧序中的槽位（从 1 起） */
  slot: number;
  /** 稳定帧标识；旧包可能没有，导入时按镜号+帧槽补算 */
  frameKey?: string;
  shotCount?: ShotCount;
  exposureSec?: number;
  aperture?: number;
  iso?: number;
  shutterAngle?: number;
  lighting?: string;
  propOffsetMm?: number;
  note?: string;
  updatedAt: number;
}

/** 包内实拍记录（去重三元组：来源包 + 设备序号 + 记录序号） */
export interface OfflineTakePayload {
  shotCode: string;
  date: string;
  takenFrames: number;
  wastedFrames: number;
  deviceSeq: number;
  takeSeq: number;
  /** 该记录最初产生时所在的包 id（棚内直登为 studio） */
  originPackageId: string;
  /** 是否场记已确认 */
  confirmed: boolean;
  updatedAt: number;
}

/** 整包结构 */
export interface OfflinePackage {
  format: typeof PACKAGE_FORMAT;
  meta: OfflinePackageMeta;
  shots: OfflineShotPayload[];
  frames: OfflineFramePayload[];
  takes: OfflineTakePayload[];
}

/** 冲突种类：曝光四元组 / 道具位移 / 实拍张数 */
export type ConflictKind = 'exposure' | 'offset' | 'shotCount';

export const CONFLICT_KIND_LABEL: Record<ConflictKind, string> = {
  exposure: '曝光参数',
  offset: '道具位移',
  shotCount: '实拍张数',
};

export type ConflictSide = 'studio' | 'location';

export const CONFLICT_SIDE_LABEL: Record<ConflictSide, string> = {
  studio: '棚内值',
  location: '外景值',
};

/** 待场记裁决的双方新值（选定前不动当前镜头） */
export interface PendingConflict {
  id?: number;
  shotId: number;
  shotCode: string;
  /** 合并时帧在 frames 表的主键（整段帧序落库会换 id，定位以 frameKey 为准） */
  frameId: number;
  frameKey: string;
  /** 帧槽（展示用） */
  slot: number;
  kind: ConflictKind;
  /** 合并前当前镜头的值（JSON 序列化） */
  baseValue: string;
  studioValue: string;
  locationValue: string;
  studioUpdatedAt: number;
  locationUpdatedAt: number;
  status: 'pending' | 'resolved';
  chosen?: ConflictSide;
  resolvedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** 容量预演结果 */
export interface CapacityPreview {
  /** navigator.storage.estimate 不可用时为 null，跳过容量校验 */
  quota: number | null;
  usage: number | null;
  available: number | null;
  /** 本次合并预计新增字节（已含安全系数） */
  requiredBytes: number;
  enough: boolean;
}

/** 单镜合并明细 */
export interface ShotMergeStat {
  shotCode: string;
  shotExisted: boolean;
  claimedFrames: number;
  appendedFrames: number;
  updatedFrames: number;
  conflicts: number;
  takesAdded: number;
}

/** 合并计划（预演产物，确认容量后再执行） */
export interface MergePlan {
  preview: CapacityPreview;
  stats: ShotMergeStat[];
  totalAppendedFrames: number;
  totalTakesAdded: number;
  totalConflicts: number;
}

/** 合并失败原因 */
export type MergeErrorCode = 'capacity' | 'invalid-package' | 'write-failed';

export class MergeError extends Error {
  code: MergeErrorCode;
  detail?: unknown;

  constructor(code: MergeErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
    this.detail = detail;
  }
}

/** 冲突值序列化：曝光为四元组对象，其余为数字（统一以 JSON 存储双方值） */
export function serializeConflictValue(value: number | ExposureBundle): string {
  return JSON.stringify(value);
}
