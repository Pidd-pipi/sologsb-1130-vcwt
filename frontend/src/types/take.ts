/** 一条实拍登记记录（按镜头 + 日期汇总当日张数） */

/** 棚内直接登记（非离线包导入）时使用的包 id */
export const STUDIO_PACKAGE_ID = 'studio';

/** 默认设备序号：棚内主机为 1，外景机在导出包时各自带序号 */
export const DEFAULT_DEVICE_SEQ = 1;

/** 实拍记录去重键：同一离线包内同一设备的同一条记录只会入库一次 */
export function buildTakeDedupeKey(packageId: string, deviceSeq: number, takeSeq: number): string {
  return `${packageId || STUDIO_PACKAGE_ID}#${Math.max(0, Math.floor(deviceSeq))}#${Math.max(0, Math.floor(takeSeq))}`;
}

export interface TakeLog {
  id?: number;
  /** 拍摄日期 YYYY-MM-DD */
  date: string;
  /** 镜号，便于按镜头阅读 */
  shotCode: string;
  /** 关联镜头 id */
  shotId: number;
  /** 实拍张数 */
  takenFrames: number;
  /** 废帧数 */
  wastedFrames: number;
  /** 剩余张数（登记时快照） */
  remainingFrames: number;
  /** 完成百分比 0-100 */
  percent: number;
  /** 拍摄设备序号（每台设备固定），与包 id、记录序号共同去重 */
  deviceSeq: number;
  /** 设备本地自增的记录序号 */
  takeSeq: number;
  /** 来源离线包 id；棚内直接登记为 studio */
  packageId: string;
  /** 去重键（包 id + 设备序号 + 记录序号） */
  dedupeKey: string;
  /** 场记已确认：确认后的实拍进度不允许被离线合并回退 */
  confirmed: boolean;
  updatedAt: number;
}

export const createEmptyTake = (shotId: number, shotCode: string): TakeLog => ({
  date: new Date().toISOString().slice(0, 10),
  shotCode,
  shotId,
  takenFrames: 0,
  wastedFrames: 0,
  remainingFrames: 0,
  percent: 0,
  deviceSeq: DEFAULT_DEVICE_SEQ,
  takeSeq: 0,
  packageId: STUDIO_PACKAGE_ID,
  dedupeKey: '',
  confirmed: false,
  updatedAt: Date.now(),
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}
