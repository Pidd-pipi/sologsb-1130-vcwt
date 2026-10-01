/**
 * 离线包导出 / 导入（序列化）服务。
 * 包是单个 JSON 文件，棚内、外景各自整包导出，回棚后两包一起合并。
 */
import {
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  type OfflineFramePayload,
  type OfflinePackage,
  type OfflinePackageMeta,
  type OfflineShotPayload,
  type OfflineTakePayload,
  type OfflineGroup,
} from '../types/offline';
import { MergeError } from '../types/offline';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { TakeLog } from '../types/take';
import { STUDIO_PACKAGE_ID } from '../types/take';
import { buildFrameKey } from '../utils/frameKey';

export interface ExportSource {
  shots: Shot[];
  /** 常规为本机 FrameEntry；也接受按镜号给出的 OfflineFramePayload */
  frames: Array<FrameEntry | OfflineFramePayload>;
  /** 常规为本机 TakeLog；也接受按镜号给出的 OfflineTakePayload */
  takes: Array<TakeLog | OfflineTakePayload>;
}

function randomPackageId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
      ? crypto.getRandomValues(new Uint32Array(2)).join('')
      : Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** 由本机数据构造离线包（按镜号过滤；frameNo 即帧槽） */
export function buildOfflinePackage(
  source: ExportSource,
  options: {
    group: OfflineGroup;
    deviceSeq: number;
    producer?: string;
    shotCodes?: string[];
    now?: number;
  },
): OfflinePackage {
  const now = options.now ?? Date.now();
  const meta: OfflinePackageMeta = {
    packageId: randomPackageId(options.group === '棚内' ? 'studio' : 'loc'),
    group: options.group,
    deviceSeq: Math.max(1, Math.floor(options.deviceSeq) || 1),
    exportedAt: now,
    formatVersion: PACKAGE_FORMAT_VERSION,
    producer: options.producer ?? '',
  };
  const codeSet = options.shotCodes ? new Set(options.shotCodes.map((c) => c.trim().toUpperCase())) : null;
  const shots = source.shots
    .filter((s) => !codeSet || codeSet.has(s.code.trim().toUpperCase()))
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
  const shotIdSet = new Set(shots.map((s) => s.id).filter((id): id is number => typeof id === 'number'));
  const codeById = new Map<number, string>();
  shots.forEach((s) => {
    if (typeof s.id === 'number') codeById.set(s.id, s.code);
  });

  const frames: OfflineFramePayload[] = (source.frames as Array<FrameEntry | OfflineFramePayload>)
    .filter((f) => {
      // 常规路径：帧属于包内镜头；
      // 兼容按镜号直接给出的导出 payload（无 shotId 但带 shotCode）。
      const shotId = (f as FrameEntry).shotId;
      if (shotIdSet.has(shotId)) return true;
      const code = (f as OfflineFramePayload).shotCode;
      return typeof code === 'string' && shots.some((s) => s.code.trim().toUpperCase() === code.trim().toUpperCase());
    })
    .slice()
    .sort((a, b) => (a as FrameEntry).shotId - (b as FrameEntry).shotId
      || ((a as OfflineFramePayload).slot ?? (a as FrameEntry).frameNo) - ((b as OfflineFramePayload).slot ?? (b as FrameEntry).frameNo))
    .map((raw) => {
      const f = raw as Partial<OfflineFramePayload & FrameEntry>;
      const code =
        (typeof f.shotId === 'number' ? codeById.get(f.shotId) : undefined) ??
        (typeof f.shotCode === 'string'
          ? shots.find((s) => s.code.trim().toUpperCase() === f.shotCode!.trim().toUpperCase())?.code
          : undefined) ??
        '';
      return {
        shotCode: code,
        slot: f.slot ?? f.frameNo ?? 1,
        frameKey: f.frameKey,
        shotCount: f.shotCount,
        exposureSec: f.exposureSec,
        aperture: f.aperture,
        iso: f.iso,
        shutterAngle: f.shutterAngle,
        lighting: f.lighting,
        propOffsetMm: f.propOffsetMm,
        note: f.note,
        updatedAt: f.updatedAt ?? now,
      };
    });

  const takes: OfflineTakePayload[] = (source.takes as Array<TakeLog | OfflineTakePayload>)
    .filter((raw) => {
      const t = raw as Partial<TakeLog & OfflineTakePayload>;
      if (typeof t.shotId === 'number' && shotIdSet.has(t.shotId)) return true;
      const code = t.shotCode;
      return typeof code === 'string' && shots.some((s) => s.code.trim().toUpperCase() === code.trim().toUpperCase());
    })
    .map((raw) => {
      const t = raw as Partial<TakeLog & OfflineTakePayload>;
      const code =
        (typeof t.shotId === 'number' ? codeById.get(t.shotId) : undefined) ??
        (typeof t.shotCode === 'string'
          ? shots.find((s) => s.code.trim().toUpperCase() === t.shotCode!.trim().toUpperCase())?.code
          : undefined) ??
        t.shotCode ??
        '';
      return {
        shotCode: code,
        date: t.date ?? '',
        takenFrames: t.takenFrames ?? 0,
        wastedFrames: t.wastedFrames ?? 0,
        deviceSeq: t.deviceSeq ?? options.deviceSeq,
        takeSeq: t.takeSeq ?? 0,
        originPackageId: t.originPackageId ?? t.packageId ?? meta.packageId,
        confirmed: t.confirmed ?? false,
        updatedAt: t.updatedAt ?? now,
      };
    });

  return { format: PACKAGE_FORMAT, meta, shots: shots.map(shotToPayload), frames, takes };
}

function shotToPayload(shot: Shot): OfflineShotPayload {
  return {
    code: shot.code,
    sceneName: shot.sceneName,
    fps: shot.fps,
    durationSec: shot.durationSec,
    startFrame: shot.startFrame,
    endFrame: shot.endFrame,
  };
}

export function serializePackage(pkg: OfflinePackage): string {
  return JSON.stringify(pkg, null, 2);
}

/** 文件内容 → 离线包，做格式校验与字段规整 */
export function parseOfflinePackage(text: string, expectedGroup?: OfflineGroup): OfflinePackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new MergeError('invalid-package', '离线包不是合法的 JSON 文件', e);
  }
  const pkg = normalizePackage(raw);
  if (expectedGroup && pkg.meta.group !== expectedGroup) {
    throw new MergeError(
      'invalid-package',
      `该包分组为「${pkg.meta.group}」，需要导入「${expectedGroup}」包`,
    );
  }
  return pkg;
}

function normalizePackage(raw: unknown): OfflinePackage {
  if (!raw || typeof raw !== 'object') {
    throw new MergeError('invalid-package', '离线包内容为空或格式不正确');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== PACKAGE_FORMAT) {
    throw new MergeError('invalid-package', `无法识别的包格式（期望 ${PACKAGE_FORMAT}）`);
  }
  const metaObj = (obj.meta ?? {}) as Record<string, unknown>;
  const group = metaObj.group === '外景' ? '外景' : '棚内';
  if (metaObj.group !== '棚内' && metaObj.group !== '外景') {
    throw new MergeError('invalid-package', '离线包缺少有效的分组（棚内 / 外景）');
  }
  const deviceSeq = Number(metaObj.deviceSeq);
  const exportedAt = Number(metaObj.exportedAt);
  const meta: OfflinePackageMeta = {
    packageId: String(metaObj.packageId ?? ''),
    group,
    deviceSeq: Number.isFinite(deviceSeq) && deviceSeq >= 1 ? Math.floor(deviceSeq) : 1,
    exportedAt: Number.isFinite(exportedAt) ? exportedAt : Date.now(),
    formatVersion: PACKAGE_FORMAT_VERSION,
    producer: String(metaObj.producer ?? ''),
  };
  if (!meta.packageId) {
    // 无包 id 的旧导出文件：按组 + 导出时间补一个，保证同文件重复导入仍去重
    meta.packageId = randomPackageId(group === '棚内' ? 'studio' : 'loc');
  }

  const shotsRaw = Array.isArray(obj.shots) ? (obj.shots as unknown[]) : [];
  const shots: OfflineShotPayload[] = shotsRaw
    .map((item) => {
      const r = (item ?? {}) as Record<string, unknown>;
      const code = String(r.code ?? '').trim();
      if (!code) return null;
      return {
        code,
        sceneName: String(r.sceneName ?? ''),
        fps: Number(r.fps) || 24,
        durationSec: Number(r.durationSec) || 0,
        startFrame: Number(r.startFrame) || 1,
        endFrame: Number(r.endFrame) || 1,
      } satisfies OfflineShotPayload;
    })
    .filter((s): s is OfflineShotPayload => !!s);

  const framesRaw = Array.isArray(obj.frames) ? (obj.frames as unknown[]) : [];
  const frames: OfflineFramePayload[] = [];
  for (const item of framesRaw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const code = String(r.shotCode ?? '').trim();
    const slot = Number(r.slot);
    if (!code || !Number.isFinite(slot) || slot < 1) continue;
    const key = typeof r.frameKey === 'string' && r.frameKey ? r.frameKey : buildFrameKey(code, slot);
    const payload: OfflineFramePayload = {
      shotCode: code,
      slot: Math.floor(slot),
      frameKey: key,
      shotCount: normalizeShotCount(r.shotCount),
      exposureSec: numOrUndef(r.exposureSec),
      aperture: numOrUndef(r.aperture),
      iso: numOrUndef(r.iso),
      shutterAngle: numOrUndef(r.shutterAngle),
      lighting: typeof r.lighting === 'string' ? r.lighting : undefined,
      propOffsetMm: numOrUndef(r.propOffsetMm),
      note: typeof r.note === 'string' ? r.note : undefined,
      updatedAt: Number(r.updatedAt) || meta.exportedAt,
    };
    // 同包内同 key 只保留更新时间最新的一条
    const idx = frames.findIndex((x) => x.frameKey === payload.frameKey);
    if (idx < 0) frames.push(payload);
    else if (payload.updatedAt > frames[idx].updatedAt) frames[idx] = payload;
  }

  const takesRaw = Array.isArray(obj.takes) ? (obj.takes as unknown[]) : [];
  const takes: OfflineTakePayload[] = takesRaw
    .map((item) => {
      const r = (item ?? {}) as Record<string, unknown>;
      const code = String(r.shotCode ?? '').trim();
      const takeSeq = Number(r.takeSeq);
      if (!code || !Number.isFinite(takeSeq) || takeSeq < 0) return null;
      return {
        shotCode: code,
        date: String(r.date ?? ''),
        takenFrames: Math.max(0, Math.floor(Number(r.takenFrames) || 0)),
        wastedFrames: Math.max(0, Math.floor(Number(r.wastedFrames) || 0)),
        deviceSeq: Number.isFinite(Number(r.deviceSeq)) && Number(r.deviceSeq) >= 1 ? Math.floor(Number(r.deviceSeq)) : meta.deviceSeq,
        takeSeq: Math.floor(takeSeq),
        originPackageId: String(r.originPackageId ?? meta.packageId),
        confirmed: !!r.confirmed,
        updatedAt: Number(r.updatedAt) || meta.exportedAt,
      } satisfies OfflineTakePayload;
    })
    .filter((t): t is OfflineTakePayload => !!t);

  if (!shots.length && !frames.length && !takes.length) {
    throw new MergeError('invalid-package', '离线包内没有任何镜头、帧或实拍记录');
  }
  return { format: PACKAGE_FORMAT, meta, shots, frames, takes };
}

function numOrUndef(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeShotCount(value: unknown): 1 | 2 | 3 | undefined {
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 ? n : undefined;
}

/** 解析包文件（浏览器 File） */
export async function readPackageFile(file: File, expectedGroup?: OfflineGroup): Promise<OfflinePackage> {
  const text = await file.text();
  return parseOfflinePackage(text, expectedGroup);
}

/** 触发浏览器下载离线包 */
export function downloadPackage(pkg: OfflinePackage): void {
  const blob = new Blob([serializePackage(pkg)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${pkg.meta.group}-${pkg.meta.deviceSeq}-${new Date(pkg.meta.exportedAt).toISOString().slice(0, 10)}.gbstop.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
