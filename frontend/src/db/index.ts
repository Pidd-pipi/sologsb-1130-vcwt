/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 帧增加稳定标识 frameKey；takes 增加去重键；新增 conflicts 表
 *      旧帧按「镜号 + 帧槽」回填确定性 frameKey（与离线设备算得一致），
 *      旧实拍记录按棚内直登补齐去重三元组。
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { DEFAULT_DEVICE_SEQ, STUDIO_PACKAGE_ID, buildTakeDedupeKey } from '../types/take';
import type { PendingConflict } from '../types/offline';
import { buildFrameKey, generateFrameKey } from '../utils/frameKey';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;
  conflicts!: Table<PendingConflict, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameKey, frameNo, [shotId+frameNo], [shotId+frameKey]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode, dedupeKey, [packageId+deviceSeq+takeSeq]',
        conflicts: '++id, shotId, frameId, frameKey, status, kind',
      })
      .upgrade(async (tx) => {
        // v4-1：旧帧按「镜号 + 帧槽」回填确定性 frameKey。
        // 同一镜号下帧按 frameNo 升序，槽位即当前序号；两台设备各自从同一基线
        // 离线后，对同一帧槽算出的 key 一致，回棚合并时可互相认领。
        const shots = await tx.table('shots').toCollection().toArray();
        const codeById = new Map<number, string>();
        for (const shot of shots as Array<Record<string, unknown>>) {
          if (typeof shot.id === 'number' && typeof shot.code === 'string') codeById.set(shot.id, shot.code);
        }
        const framesByShot = new Map<number, Array<Record<string, unknown>>>();
        for (const frame of (await tx.table('frames').toCollection().toArray()) as Array<Record<string, unknown>>) {
          if (typeof frame.shotId !== 'number') continue;
          const list = framesByShot.get(frame.shotId) ?? [];
          list.push(frame);
          framesByShot.set(frame.shotId, list);
        }
        for (const [shotId, list] of framesByShot) {
          const code = codeById.get(shotId) ?? '';
          list.sort((a, b) => Number(a.frameNo ?? 0) - Number(b.frameNo ?? 0));
          await Promise.all(
            list.map((row, idx) => {
              if (typeof row.frameKey === 'string' && row.frameKey) return Promise.resolve();
              return tx.table('frames').update(row.id as number, {
                frameKey: code ? buildFrameKey(code, idx + 1) : generateFrameKey(),
              });
            }),
          );
        }

        // v4-2：旧实拍记录补齐去重三元组（均视为棚内直登），
        // 同库内取递增 takeSeq 保证 dedupeKey 唯一。
        const takeRows = (await tx.table('takes').toCollection().toArray()) as Array<Record<string, unknown>>;
        const seqByDevice = new Map<number, number>();
        takeRows.sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
        for (const row of takeRows) {
          const deviceSeq = typeof row.deviceSeq === 'number' ? row.deviceSeq : DEFAULT_DEVICE_SEQ;
          const nextSeq = (seqByDevice.get(deviceSeq) ?? 0) + 1;
          seqByDevice.set(deviceSeq, nextSeq);
          const takeSeq = typeof row.takeSeq === 'number' && row.takeSeq > 0 ? row.takeSeq : nextSeq;
          const packageId = typeof row.packageId === 'string' && row.packageId ? row.packageId : STUDIO_PACKAGE_ID;
          const patch: Record<string, unknown> = {
            deviceSeq,
            takeSeq,
            packageId,
            confirmed: typeof row.confirmed === 'boolean' ? row.confirmed : false,
          };
          if (typeof row.dedupeKey !== 'string' || !row.dedupeKey) {
            patch.dedupeKey = buildTakeDedupeKey(packageId, deviceSeq, takeSeq);
          }
          await tx.table('takes').update(row.id as number, patch);
        }
      });
  }
}

export const db = new StopMotionDb();
