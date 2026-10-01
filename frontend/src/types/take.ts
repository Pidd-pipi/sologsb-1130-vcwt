/** 一条实拍登记记录（按镜头 + 日期汇总当日张数） */
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
  /** 来源离线包 id（回棚合并时盖印，用于整包去重） */
  packageId?: string;
  /** 来源设备序号（随包带走，用于按设备去重） */
  deviceSerial?: string;
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
  updatedAt: Date.now(),
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}
