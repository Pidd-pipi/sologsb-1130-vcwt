/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { FrameConflict } from '../types/conflict';
import type { MergeBatch } from '../types/package';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
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
  return db.frames.add(toPlain(frame));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(f)));
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
  const plain = frames.map((f) => toPlain(f));
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

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  return db.takes.where('shotId').equals(shotId).toArray();
}

export async function addTake(take: TakeLog): Promise<number> {
  return db.takes.add(toPlain(take));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}

/* ---------------- 离线合并支持：冲突 / 批次 / 快照 ---------------- */

export async function findFrame(shotId: number, frameNo: number): Promise<FrameEntry | undefined> {
  return db.frames.where({ shotId, frameNo }).first();
}

export async function bulkAddFrames(rows: FrameEntry[]): Promise<void> {
  if (!rows.length) return;
  await db.frames.bulkAdd(rows.map((f) => toPlain(f)));
}

export async function bulkAddTakes(rows: TakeLog[]): Promise<void> {
  if (!rows.length) return;
  await db.takes.bulkAdd(rows.map((t) => toPlain(t)));
}

export async function bulkPutProps(rows: PropState[]): Promise<void> {
  if (!rows.length) return;
  await db.props.bulkPut(rows.map((p) => toPlain(p)));
}

export async function listConflicts(): Promise<FrameConflict[]> {
  const rows = await db.conflicts.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt || (a.id ?? 0) - (b.id ?? 0));
}

export async function findPendingConflict(shotCode: string, frameNo: number): Promise<FrameConflict | undefined> {
  return db.conflicts.where('[shotCode+frameNo]').equals([shotCode, frameNo]).and((c) => c.status === 'pending').first();
}

export async function addConflict(row: FrameConflict): Promise<number> {
  return db.conflicts.add(toPlain(row));
}

export async function updateConflict(id: number, patch: Partial<FrameConflict>): Promise<void> {
  await db.conflicts.update(id, toPlain(patch));
}

export async function listMergeBatches(): Promise<MergeBatch[]> {
  return db.mergeBatches.orderBy('importedAt').reverse().toArray();
}

export async function findMergeBatch(packageId: string): Promise<MergeBatch | undefined> {
  return db.mergeBatches.where('packageId').equals(packageId).first();
}

export async function addMergeBatch(row: MergeBatch): Promise<number> {
  return db.mergeBatches.add(toPlain(row));
}

/** 全库快照：合并前备份，写入失败后恢复合并前内容 */
export interface DbSnapshot {
  shots: Shot[];
  frames: FrameEntry[];
  props: PropState[];
  takes: TakeLog[];
  conflicts: FrameConflict[];
  mergeBatches: MergeBatch[];
}

export async function exportSnapshot(): Promise<DbSnapshot> {
  const [shots, frames, props, takes, conflicts, mergeBatches] = await Promise.all([
    db.shots.toArray(),
    db.frames.toArray(),
    db.props.toArray(),
    db.takes.toArray(),
    db.conflicts.toArray(),
    db.mergeBatches.toArray(),
  ]);
  return {
    shots: shots.map((s) => toPlain(s)),
    frames: frames.map((f) => toPlain(f)),
    props: props.map((p) => toPlain(p)),
    takes: takes.map((t) => toPlain(t)),
    conflicts: conflicts.map((c) => toPlain(c)),
    mergeBatches: mergeBatches.map((b) => toPlain(b)),
  };
}

/** 用快照恢复全库（清空后按原样写回），保证写入失败后可重试 */
export async function restoreSnapshot(snap: DbSnapshot): Promise<void> {
  await db.transaction('rw', [db.shots, db.frames, db.props, db.takes, db.conflicts, db.mergeBatches], async () => {
    await Promise.all([
      db.shots.clear(),
      db.frames.clear(),
      db.props.clear(),
      db.takes.clear(),
      db.conflicts.clear(),
      db.mergeBatches.clear(),
    ]);
    if (snap.shots.length) await db.shots.bulkAdd(snap.shots);
    if (snap.frames.length) await db.frames.bulkAdd(snap.frames);
    if (snap.props.length) await db.props.bulkAdd(snap.props);
    if (snap.takes.length) await db.takes.bulkAdd(snap.takes);
    if (snap.conflicts.length) await db.conflicts.bulkAdd(snap.conflicts);
    if (snap.mergeBatches.length) await db.mergeBatches.bulkAdd(snap.mergeBatches);
  });
}
