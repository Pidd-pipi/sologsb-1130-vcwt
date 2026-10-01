/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import {
  DEFAULT_DEVICE_SEQ,
  STUDIO_PACKAGE_ID,
  buildTakeDedupeKey,
  type TakeLog,
} from '../types/take';
import type { ConflictSide, PendingConflict } from '../types/offline';
import { generateFrameKey } from '../utils/frameKey';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/** 帧落库前确保带稳定标识；缺 key 的（旧代码路径）补随机新帧 key */
function withFrameKey<T extends Partial<FrameEntry>>(frame: T): T {
  if (typeof frame.frameKey === 'string' && frame.frameKey) return frame;
  return { ...frame, frameKey: generateFrameKey() };
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function listAllShots(): Promise<Shot[]> {
  return db.shots.toArray();
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

/** 合并专用：不刷 updatedAt 的整体覆盖（合并时间戳由计划决定） */
export async function putShot(shot: Shot): Promise<number> {
  return db.shots.put(toPlain(shot));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(withFrameKey(frame)));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(withFrameKey(f))));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const { id, ...rest } = row;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  const plain = frames.map((f) => toPlain(withFrameKey({ ...f, shotId })));
  await db.transaction('rw', db.frames, async () => {
    await db.frames.where('shotId').equals(shotId).delete();
    if (plain.length) await db.frames.bulkAdd(plain);
  });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listAllTakes(): Promise<TakeLog[]> {
  return db.takes.toArray();
}

export async function findTakeByDedupeKey(dedupeKey: string): Promise<TakeLog | undefined> {
  return db.takes.where('dedupeKey').equals(dedupeKey).first();
}

/** 棚内直接登记：自动分配设备内自增序号与去重键 */
export async function addTake(take: TakeLog): Promise<number> {
  const deviceSeq = take.deviceSeq || DEFAULT_DEVICE_SEQ;
  const takeSeq = take.takeSeq > 0 ? take.takeSeq : await nextTakeSeq(deviceSeq);
  const packageId = take.packageId || STUDIO_PACKAGE_ID;
  const row: TakeLog = {
    ...take,
    deviceSeq,
    takeSeq,
    packageId,
    dedupeKey: take.dedupeKey || buildTakeDedupeKey(packageId, deviceSeq, takeSeq),
    confirmed: take.confirmed ?? false,
  };
  return db.takes.add(toPlain(row));
}

/** 设备内下一条记录序号（按包 + 设备序号去重的自增段） */
export async function nextTakeSeq(deviceSeq: number = DEFAULT_DEVICE_SEQ): Promise<number> {
  const rows = await db.takes.toArray();
  return rows.reduce((max, r) => (r.deviceSeq === deviceSeq ? Math.max(max, r.takeSeq || 0) : max), 0) + 1;
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

/** 场记确认实拍记录；确认后的进度不允许离线合并回退 */
export async function confirmTake(id: number): Promise<void> {
  await db.takes.update(id, toPlain({ confirmed: true, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}

/* ---------------- 离线合并冲突 ---------------- */

export async function listConflicts(): Promise<PendingConflict[]> {
  const rows = await db.conflicts.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt || a.slot - b.slot);
}

export async function listPendingConflicts(): Promise<PendingConflict[]> {
  const rows = await db.conflicts.where('status').equals('pending').toArray();
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.slot - b.slot);
}

export async function addConflict(conflict: PendingConflict): Promise<number> {
  return db.conflicts.add(toPlain(conflict));
}

export async function markConflictResolved(id: number, chosen: ConflictSide): Promise<void> {
  await db.conflicts.update(
    id,
    toPlain({ status: 'resolved', chosen, resolvedAt: Date.now(), updatedAt: Date.now() }),
  );
}

export async function deleteConflict(id: number): Promise<void> {
  await db.conflicts.delete(id);
}

/* ---------------- 合并专用批量原语（在单个事务内调用） ---------------- */

export async function bulkPutShots(rows: Shot[]): Promise<void> {
  if (!rows.length) return;
  await db.shots.bulkPut(rows.map((r) => toPlain(r)));
}

export async function bulkPutFrames(rows: FrameEntry[]): Promise<void> {
  if (!rows.length) return;
  await db.frames.bulkPut(rows.map((r) => toPlain(withFrameKey(r))));
}

export async function bulkAddTakes(rows: TakeLog[]): Promise<void> {
  if (!rows.length) return;
  await db.takes.bulkAdd(rows.map((r) => toPlain(r)));
}

export async function bulkAddConflicts(rows: PendingConflict[]): Promise<void> {
  if (!rows.length) return;
  await db.conflicts.bulkAdd(rows.map((r) => toPlain(r)));
}

/* ---------------- 整库快照 / 恢复（写入失败回滚 + 允许重试） ---------------- */

export interface DatabaseSnapshot {
  shots: Shot[];
  frames: FrameEntry[];
  props: PropState[];
  takes: TakeLog[];
  conflicts: PendingConflict[];
}

/** 合并前快照：全部业务表整表只读一份纯对象 */
export async function snapshotDatabase(): Promise<DatabaseSnapshot> {
  const [shots, frames, props, takes, conflicts] = await Promise.all([
    db.shots.toArray(),
    db.frames.toArray(),
    db.props.toArray(),
    db.takes.toArray(),
    db.conflicts.toArray(),
  ]);
  return {
    shots: shots.map((s) => toPlain(s)),
    frames: frames.map((f) => toPlain(f)),
    props: props.map((p) => toPlain(p)),
    takes: takes.map((t) => toPlain(t)),
    conflicts: conflicts.map((c) => toPlain(c)),
  };
}

/** 恢复到快照内容：清空五张表后整体写回（用于合并写入失败后的兜底回滚） */
export async function restoreDatabase(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, db.conflicts, async () => {
    await Promise.all([
      db.shots.clear(),
      db.frames.clear(),
      db.props.clear(),
      db.takes.clear(),
      db.conflicts.clear(),
    ]);
    await db.shots.bulkAdd(snapshot.shots.map((s) => toPlain(s)));
    await db.frames.bulkAdd(snapshot.frames.map((f) => toPlain(f)));
    await db.props.bulkAdd(snapshot.props.map((p) => toPlain(p)));
    await db.takes.bulkAdd(snapshot.takes.map((t) => toPlain(t)));
    await db.conflicts.bulkAdd(snapshot.conflicts.map((c) => toPlain(c)));
  });
}
