/**
 * 离线包：棚内 / 外景两组离线排同一镜头后，整包导出、回棚导入。
 * 包内数据与 IndexedDB 表同构，但帧条目不带本地自增 id（按镜号 + 帧槽认领）。
 */
import type { Shot } from './shot';
import type { FrameEntry } from './frame';
import type { PropState } from './prop';
import type { TakeLog } from './take';

/** 分组：棚内 / 外景 */
export type PackageGroup = 'studio' | 'location';

export const GROUP_LABELS: Record<PackageGroup, string> = {
  studio: '棚内',
  location: '外景',
};

export const PACKAGE_FORMAT = 'gbstopmotion-offline-package' as const;
export const PACKAGE_VERSION = 1;

export interface OfflinePackage {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  /** 包标识（导出时生成，用于整包去重） */
  packageId: string;
  /** 设备序号（写入本机 localStorage，随包带走） */
  deviceSerial: string;
  /** 分组 */
  group: PackageGroup;
  /** 导出时间戳 */
  exportedAt: number;
  appVersion: string;
  shots: Shot[];
  frames: FrameEntry[];
  props: PropState[];
  takes: TakeLog[];
}

/** 已导入的批次（按包 + 设备序号留痕） */
export interface MergeBatch {
  id?: number;
  packageId: string;
  deviceSerial: string;
  group: PackageGroup;
  exportedAt: number;
  importedAt: number;
  shotsAdded: number;
  framesAdded: number;
  framesClaimed: number;
  takesAdded: number;
  takesSkipped: number;
}

/** 合并结果报告 */
export interface MergeReport {
  ok: boolean;
  rejected: boolean;
  rejectReason?: string;
  packageId: string;
  deviceSerial: string;
  group: PackageGroup;
  exportedAt: number;
  shotsAdded: number;
  shotsMatched: number;
  framesAdded: number;
  framesClaimed: number;
  conflicts: number;
  takesAdded: number;
  takesSkipped: number;
  propsAdded: number;
  propsUpdated: number;
  batch?: MergeBatch;
}

/** 合并前容量预演 */
export interface StoragePreflight {
  /** 包 JSON 字节数 */
  bytes: number;
  /** 浏览器配额 */
  quota: number;
  /** 已用空间 */
  usage: number;
  /** 剩余空间 */
  remaining: number;
  /** 预估需要（包体 × 膨胀系数 + 余量） */
  needed: number;
  /** 是否通过预演 */
  ok: boolean;
  /** 浏览器是否支持 storage.estimate */
  supported: boolean;
}
