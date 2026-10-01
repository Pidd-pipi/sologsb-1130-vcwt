/**
 * 帧冲突：同一镜号 + 帧槽两边都改了曝光或道具位移，
 * 合并时先留双方值，等场记选定后再更新当前镜头。
 */
import type { FrameEntry } from './frame';

export type ConflictStatus = 'pending' | 'resolved';
export type ConflictResolution = 'local' | 'incoming';

export interface FrameConflict {
  id?: number;
  /** 镜号（Shot.code，认领键的一部分） */
  shotCode: string;
  /** 帧槽（帧序号） */
  frameNo: number;
  /** 冲突字段：exposureSec / aperture / iso / shutterAngle / propOffsetMm */
  fields: string[];
  /** 本地（棚内先回）值快照 */
  local: FrameEntry;
  /** 外景包带来的值快照 */
  incoming: FrameEntry;
  status: ConflictStatus;
  /** 场记选定的一方 */
  resolution?: ConflictResolution;
  createdAt: number;
  resolvedAt?: number;
}
