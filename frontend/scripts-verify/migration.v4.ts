/* eslint-disable */
// @ts-nocheck
/** v3 旧库 → v4 升级迁移验证：旧帧回填稳定 frameKey、旧实拍补齐去重字段 */
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true });

import Dexie from 'dexie';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

const DB_NAME = 'gbstopmotion-db';

// 1) 以 v3 schema 造旧库
const oldDb = new Dexie(DB_NAME);
oldDb.version(3).stores({
  shots: '++id, code, status, sceneName',
  frames: '++id, shotId, frameNo, [shotId+frameNo]',
  props: '++id, shotId, name, [shotId+fromFrame]',
  takes: '++id, shotId, date, shotCode',
});
await oldDb.open();
await oldDb.table('shots').add({
  code: 'S01', sceneName: 'x', fps: 24, durationSec: 0.125, startFrame: 1, endFrame: 3,
  status: '拍摄中', owner: '', progressPercent: 0, createdAt: 1, updatedAt: 1,
});
await oldDb.table('frames').bulkAdd([
  { shotId: 1, frameNo: 1, shotCount: 2, exposureSec: 0.25, aperture: 5.6, iso: 200, shutterAngle: 180, lighting: '主灯', propOffsetMm: 1, note: '', updatedAt: 2 },
  { shotId: 1, frameNo: 2, shotCount: 2, exposureSec: 0.25, aperture: 5.6, iso: 200, shutterAngle: 180, lighting: '主灯', propOffsetMm: 2, note: '', updatedAt: 2 },
]);
await oldDb.table('takes').add({
  date: '2026-09-30', shotCode: 'S01', shotId: 1, takenFrames: 1, wastedFrames: 0,
  remainingFrames: 2, percent: 33, updatedAt: 3,
});
oldDb.close();

// 2) 用新代码打开 → 触发 v4 upgrade
const { db } = await import('../src/db/index');
await db.open();

const frames = await db.table('frames').toArray();
assert(frames.length === 2, '帧全部保留');
assert(frames[0].frameKey === 'fk:S01:1', `帧1 key 为 fk:S01:1（实际 ${frames[0].frameKey}）`);
assert(frames[1].frameKey === 'fk:S01:2', `帧2 key 为 fk:S01:2（实际 ${frames[1].frameKey}）`);

// 3) 升级后生成的新帧 key 仍稳定且不与槽位 key 冲突
const { generateFrameKey, isSlotFrameKey } = await import('../src/utils/frameKey');
const newKey = generateFrameKey();
assert(newKey.startsWith('fk:n:'), `新帧 key 为随机命名空间（实际 ${newKey}）`);
assert(isSlotFrameKey(frames[0].frameKey), '槽位 key 可被识别');
assert(!isSlotFrameKey(newKey), '随机新帧 key 不被识别为槽位 key');

const takes = await db.table('takes').toArray();
assert(takes[0].dedupeKey === 'studio#1#1', `实拍补齐 dedupeKey（实际 ${takes[0].dedupeKey}）`);
assert(takes[0].packageId === 'studio', '旧实拍归为棚内直登');
assert(takes[0].deviceSeq === 1 && takes[0].takeSeq === 1, '设备序号/记录序号补齐');
assert(takes[0].confirmed === false, '旧实拍默认未确认');

db.close();
console.log(`\n迁移验证 ${passed} 条断言通过`);
