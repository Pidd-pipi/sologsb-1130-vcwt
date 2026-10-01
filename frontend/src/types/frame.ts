/** 单帧拍摄张数（定格动画常用 1/2/3 张） */
export type ShotCount = 1 | 2 | 3;

export const SHOT_COUNT_OPTIONS: ShotCount[] = [1, 2, 3];

/**
 * 帧条目：一帧的曝光参数、道具位移与实拍记录。
 * frameKey 是跨设备、跨离线包的稳定标识：
 * 新帧由 buildFrameKey 随机生成；旧数据（v3 及以前）在 v4 升级时
 * 按「镜号 + 帧槽」回填，保证棚内/外景两台设备算出的同一帧槽 key 一致。
 */
export interface FrameEntry {
  id?: number;
  /** 稳定帧标识，不随帧序号重排、插入、删除而变化 */
  frameKey: string;
  /** 帧序号，从 1 开始，随排序重排 */
  frameNo: number;
  /** 所属镜头 id */
  shotId: number;
  /** 拍摄张数 */
  shotCount: ShotCount;
  /** 曝光时间（秒） */
  exposureSec: number;
  /** 光圈 f 值 */
  aperture: number;
  /** 感光度 */
  iso: number;
  /** 快门角度（度） */
  shutterAngle: number;
  /** 灯光配置 */
  lighting: string;
  /** 道具位移量（mm） */
  propOffsetMm: number;
  /** 备注 */
  note: string;
  updatedAt: number;
}

export const createEmptyFrame = (shotId: number, frameNo: number): FrameEntry => ({
  frameKey: '',
  frameNo,
  shotId,
  shotCount: 2,
  exposureSec: 0.25,
  aperture: 5.6,
  iso: 200,
  shutterAngle: 180,
  lighting: '主灯 + 柔光箱',
  propOffsetMm: 0,
  note: '',
  updatedAt: Date.now(),
});

/** 批量曝光设置（供 /frames 编排台使用） */
export interface BatchExposure {
  exposureSec: number;
  aperture: number;
  iso: number;
  shutterAngle: number;
}

/** 一帧的完整曝光参数（离线合并时作为一个整体参与冲突裁决） */
export interface ExposureBundle extends BatchExposure {
  lighting: string;
}
