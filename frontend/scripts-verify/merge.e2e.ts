/* eslint-disable */
// @ts-nocheck
/**
 * 临时端到端验证（fake-indexeddb）：认领/新增帧/冲突挂起/裁决、
 * 实拍去重与进度不回退、新镜头、容量整批拒绝、写入失败恢复与重试、双方同值。
 */
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true });

import { db } from '../src/db/index';
import * as api from '../src/db/api';
import { buildOfflinePackage } from '../src/services/offlinePackage';
import { mergeOfflinePackages, planMerge, previewCapacity, resolveConflict } from '../src/services/mergeEngine';
import { buildFrameKey } from '../src/utils/frameKey';
import { createEmptyFrame } from '../src/types/frame';
import { MergeError } from '../src/types/offline';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

async function resetDb() {
  await db.delete();
  await db.open();
}

function shotRow(id, code, overrides = {}) {
  return {
    id,
    code,
    sceneName: '棚景',
    fps: 24,
    durationSec: 0.125,
    startFrame: 1,
    endFrame: 3,
    status: '拍摄中',
    owner: '',
    progressPercent: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

async function seedStudioShot() {
  const { id: _omit, ...plain } = shotRow(undefined, 'S01');
  const shotId = await api.addShot(plain);
  const frames = [1, 2, 3].map((slot) => ({
    ...createEmptyFrame(shotId, slot),
    frameKey: buildFrameKey('S01', slot),
    exposureSec: 0.25,
    propOffsetMm: slot,
    updatedAt: 2000,
  }));
  await api.addFrames(frames);
  return shotId;
}

function pkgFrame(shotCode, slot, patch) {
  return { shotCode, slot, frameKey: buildFrameKey(shotCode, slot), updatedAt: 5000, ...patch };
}

function makePkg(group, deviceSeq, source) {
  return buildOfflinePackage(source, { group, deviceSeq });
}

async function testClaimAppendConflict() {
  console.log('场景 1：按镜号+帧槽认领、新增帧接尾、双方新值冲突挂起');
  await resetDb();
  const shotId = await seedStudioShot();
  const s1 = shotRow(shotId, 'S01', { endFrame: 5, durationSec: 5 / 24 });

  const studio = makePkg('棚内', 1, {
    shots: [s1],
    frames: [
      pkgFrame('S01', 2, { exposureSec: 0.5, updatedAt: 6000 }),
      pkgFrame('S01', 4, { propOffsetMm: 8, updatedAt: 6000 }),
    ],
    takes: [],
  });
  const location = makePkg('外景', 2, {
    shots: [s1],
    frames: [
      pkgFrame('S01', 2, { exposureSec: 1, updatedAt: 6100 }),
      pkgFrame('S01', 5, { propOffsetMm: 10, updatedAt: 6100 }),
    ],
    takes: [],
  });

  const result = await mergeOfflinePackages(studio, location);
  assert(result.totalAppendedFrames === 2, `新增 2 帧（实际 ${result.totalAppendedFrames}）`);
  assert(result.totalConflicts === 1, `1 处曝光冲突（实际 ${result.totalConflicts}）`);

  const frames = await api.listFrames(shotId);
  assert(frames.length === 5, '合并后共 5 帧');
  assert(frames.map((f) => f.frameNo).join(',') === '1,2,3,4,5', '帧序号重排为 1..5');
  assert(frames[1].exposureSec === 0.25, '冲突帧当前镜头保持原曝光 0.25');
  assert(frames[3].propOffsetMm === 8, '新增帧 4 位移 8');
  assert(frames[4].propOffsetMm === 10, '新增帧 5 位移 10');
  assert(frames.every((f) => f.frameKey), '所有帧都有 frameKey');

  const conflicts = await api.listPendingConflicts();
  assert(conflicts.length === 1, '冲突表有 1 条 pending');
  assert(JSON.parse(conflicts[0].studioValue).exposureSec === 0.5, '保留棚内值 0.5');
  assert(JSON.parse(conflicts[0].locationValue).exposureSec === 1, '保留外景值 1.0');

  await resolveConflict(conflicts[0].id, 'location');
  const after = await api.listFrames(shotId);
  assert(after[1].exposureSec === 1, '裁决后当前镜头第 2 帧曝光更新为 1.0');
  const resolved = await api.listConflicts();
  assert(resolved[0].status === 'resolved' && resolved[0].chosen === 'location', '冲突标记 resolved/location');
}

function takeRow(packageId, deviceSeq, takeSeq, taken, confirmed) {
  return {
    shotCode: 'S01',
    date: '2026-09-30',
    takenFrames: taken,
    wastedFrames: 0,
    deviceSeq,
    takeSeq,
    originPackageId: packageId,
    confirmed,
    updatedAt: 7000,
  };
}

async function testTakeDedupeAndProgress() {
  console.log('场景 2：实拍按包+设备序号去重，已确认进度不回退');
  await resetDb();
  const shotId = await seedStudioShot();
  const s1 = shotRow(shotId, 'S01');

  const a = makePkg('棚内', 1, { shots: [s1], frames: [], takes: [takeRow('pkgA', 1, 1, 2, true)] });
  a.meta.packageId = 'pkgA';
  const b = makePkg('外景', 2, { shots: [s1], frames: [], takes: [] });
  b.meta.packageId = 'pkgB';
  const r1 = await mergeOfflinePackages(a, b);
  assert(r1.totalTakesAdded === 1, '首次加入 1 条实拍');
  const shot1 = await api.getShot(shotId);
  assert(shot1.progressPercent === 67, `确认进度 2/3=67%（实际 ${shot1.progressPercent}）`);

  // 同一包重复导入：去重
  const a2 = makePkg('棚内', 1, { shots: [s1], frames: [], takes: [takeRow('pkgA', 1, 1, 2, true)] });
  a2.meta.packageId = 'pkgA';
  const b2 = makePkg('外景', 2, { shots: [s1], frames: [], takes: [] });
  b2.meta.packageId = 'pkgB';
  const r2 = await mergeOfflinePackages(a2, b2);
  assert(r2.totalTakesAdded === 0, '重复包不新增实拍记录');
  const takes = await api.listAllTakes();
  assert(takes.length === 1, `库里仍只有 1 条实拍（实际 ${takes.length}）`);

  // 空合并：已确认进度保持
  const a3 = makePkg('棚内', 1, { shots: [s1], frames: [], takes: [] });
  a3.meta.packageId = 'pkgA';
  const b3 = makePkg('外景', 2, { shots: [s1], frames: [], takes: [] });
  b3.meta.packageId = 'pkgC';
  await mergeOfflinePackages(a3, b3);
  const shot3 = await api.getShot(shotId);
  assert(shot3.progressPercent === 67, `无新数据时确认进度保持 67%（实际 ${shot3.progressPercent}）`);

  // 另一台设备新确认记录：进度只升
  const b4 = makePkg('外景', 2, { shots: [s1], frames: [], takes: [takeRow('pkgC', 2, 1, 1, true)] });
  b4.meta.packageId = 'pkgC';
  await mergeOfflinePackages(a3, b4);
  const shot4 = await api.getShot(shotId);
  assert(shot4.progressPercent === 100, `累计 3/3=100%（实际 ${shot4.progressPercent}）`);
  const allTakes = await api.listAllTakes();
  assert(allTakes.length === 2, `不同设备记录各自保留共 2 条（实际 ${allTakes.length}）`);
}

async function testNewShot() {
  console.log('场景 3：本机不存在的新镜头随包创建');
  await resetDb();
  const s99 = shotRow(1, 'S99', { sceneName: '新景', fps: 12, durationSec: 2 / 12, endFrame: 2, status: '未开机' });
  const studio = makePkg('棚内', 1, {
    shots: [s99],
    frames: [pkgFrame('S99', 1, { propOffsetMm: 1 }), pkgFrame('S99', 2, { propOffsetMm: 2 })],
    takes: [],
  });
  const location = makePkg('外景', 2, { shots: [s99], frames: [], takes: [] });
  const result = await mergeOfflinePackages(studio, location);
  assert(result.stats[0].shotExisted === false, 'S99 是新建镜头');
  const shots = await api.listAllShots();
  assert(shots.length === 1 && shots[0].code === 'S99', '新镜头已入库');
  const fs = await api.listFrames(shots[0].id);
  assert(fs.length === 2 && fs[0].frameNo === 1 && fs[1].frameNo === 2, '新镜头 2 帧有序');
}

async function testCapacityReject() {
  console.log('场景 4：容量不足整批拒绝，两个包保留、库不变');
  await resetDb();
  const shotId = await seedStudioShot();
  const s1 = shotRow(shotId, 'S01');

  const studio = makePkg('棚内', 1, { shots: [s1], frames: [pkgFrame('S01', 2, { exposureSec: 0.5 })], takes: [] });
  const location = makePkg('外景', 2, { shots: [s1], frames: [], takes: [] });

  const prepared = await planMerge(studio, location);
  const preview = await previewCapacity(prepared);
  assert(preview.requiredBytes > 0, `容量估算为正数（${preview.requiredBytes}）`);

  if (!navigator.storage) navigator.storage = {};
  const originalEstimate = navigator.storage.estimate?.bind(navigator.storage);
  navigator.storage.estimate = async () => ({ quota: 100, usage: 99 });
  let rejected = null;
  try {
    await mergeOfflinePackages(studio, location);
  } catch (e) {
    rejected = e;
  } finally {
    if (originalEstimate) navigator.storage.estimate = originalEstimate;
    else delete (navigator as { storage?: unknown }).storage;
  }
  assert(rejected instanceof MergeError && rejected.code === 'capacity', '抛出 capacity MergeError');
  const frames = await api.listAllFrames();
  assert(frames.length === 3 && frames[1].exposureSec === 0.25, '容量拒绝后帧数据完全不变');
  const conflicts = await api.listConflicts();
  assert(conflicts.length === 0, '容量拒绝后没有冲突写入');
}

async function testFailureRestoreAndRetry() {
  console.log('场景 5：写入失败恢复合并前内容，并允许重试');
  await resetDb();
  const shotId = await seedStudioShot();
  const s1 = shotRow(shotId, 'S01');

  const studio = makePkg('棚内', 1, { shots: [s1], frames: [pkgFrame('S01', 2, { exposureSec: 0.5 })], takes: [] });
  const location = makePkg('外景', 2, { shots: [s1], frames: [], takes: [] });

  const beforeCount = (await api.listAllFrames()).length;

  const originalBulkPut = db.frames.bulkPut.bind(db.frames);
  db.frames.bulkPut = async () => {
    throw new Error('模拟磁盘写入失败');
  };
  let failed = null;
  try {
    await mergeOfflinePackages(studio, location);
  } catch (e) {
    failed = e;
  } finally {
    db.frames.bulkPut = originalBulkPut;
  }
  assert(failed instanceof MergeError && failed.code === 'write-failed', '抛出 write-failed MergeError');
  const restored = await api.listAllFrames();
  assert(restored.length === beforeCount, '恢复后帧数与合并前一致');
  assert(restored[1].exposureSec === 0.25, '恢复后第 2 帧曝光回到原值 0.25');

  const retry = await mergeOfflinePackages(studio, location);
  assert(retry.totalAppendedFrames === 0, '重试无新增帧');
  const after = await api.listAllFrames();
  assert(after[1].exposureSec === 0.5, '重试后第 2 帧曝光更新为 0.5');
}

async function testBothSidesSameValue() {
  console.log('场景 6：两边新值相同不产生冲突，直接采用');
  await resetDb();
  const shotId = await seedStudioShot();
  const s1 = shotRow(shotId, 'S01');
  const mk = (deviceSeq) =>
    makePkg(deviceSeq === 1 ? '棚内' : '外景', deviceSeq, {
      shots: [s1],
      frames: [pkgFrame('S01', 2, { propOffsetMm: 42, exposureSec: 0.5 })],
      takes: [],
    });
  const result = await mergeOfflinePackages(mk(1), mk(2));
  assert(result.totalConflicts === 0, '同值无冲突');
  const frames = await api.listAllFrames();
  assert(frames[1].propOffsetMm === 42 && frames[1].exposureSec === 0.5, '同值直接采用到当前帧');
}

async function run() {
  try {
    await testClaimAppendConflict();
    await testTakeDedupeAndProgress();
    await testNewShot();
    await testCapacityReject();
    await testFailureRestoreAndRetry();
    await testBothSidesSameValue();
    console.log(`\n全部 ${passed} 条断言通过`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

void run();
