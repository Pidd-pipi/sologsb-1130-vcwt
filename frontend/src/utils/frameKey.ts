/**
 * 稳定帧标识工具。
 *
 * 棚内与外景两组离线排同一镜头：帧序号（frameNo）会随插入/删除重排，
 * 不能作为跨设备认领依据，因此每个 FrameEntry 携带 frameKey。
 *
 * - 槽位 key（buildFrameKey）：旧数据在 v4 升级时按「镜号 + 帧槽」回填，
 *   两台设备对同一镜号同一槽位算出的 key 必然一致，可互相认领；
 * - 新建 key（generateFrameKey）：升级后运行期新增的帧随机生成，全局唯一，
 *   随离线包带到任意设备都不会与他人碰撞。
 */

export const FRAME_KEY_PREFIX = 'fk';

function normalizeCode(code: string): string {
  return String(code ?? '')
    .trim()
    .toUpperCase();
}

function safeSlot(slot: number): number {
  return Number.isFinite(slot) ? Math.max(1, Math.floor(slot)) : 1;
}

/** 镜号 + 帧槽 → 确定性稳定标识（同一输入永远得到同一输出） */
export function buildFrameKey(shotCode: string, slot: number): string {
  return `${FRAME_KEY_PREFIX}:${normalizeCode(shotCode)}:${safeSlot(slot)}`;
}

/** 槽位 key 形如 fk:S01:12，第三段是纯数字 */
export function isSlotFrameKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const parts = key.split(':');
  return parts.length === 3 && parts[0] === FRAME_KEY_PREFIX && parts[1] !== '' && /^\d+$/.test(parts[2]);
}

/** 解析槽位 key，返回大写镜号与帧槽；非槽位 key 返回 null */
export function parseSlotFrameKey(key: string): { code: string; slot: number } | null {
  if (!isSlotFrameKey(key)) return null;
  const [, code, slotText] = key.split(':');
  return { code, slot: Number(slotText) };
}

function randomPart(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return `${buf[0].toString(36)}${buf[1].toString(36)}`;
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** 运行期新建帧的全局唯一 key：fk:n:<base36 时间戳>-<随机串> */
export function generateFrameKey(now: number = Date.now()): string {
  return `${FRAME_KEY_PREFIX}:n:${now.toString(36)}-${randomPart()}`;
}
