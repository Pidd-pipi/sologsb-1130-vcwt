/**
 * 设备序号：每台离线设备一个稳定标识，随实拍记录与离线包带走，
 * 用于「按包 + 设备序号」去重。持久化在 localStorage，清缓存才会变。
 */
const DEVICE_SERIAL_KEY = 'gbstopmotion:device-serial';

export function createDeviceSerial(): string {
  return `dev_${Math.random().toString(36).slice(2, 10)}`;
}

export function getDeviceSerial(): string {
  try {
    const existing = localStorage.getItem(DEVICE_SERIAL_KEY);
    if (existing) return existing;
  } catch {
    /* localStorage 不可用时回落内存值 */
  }
  const serial = createDeviceSerial();
  try {
    localStorage.setItem(DEVICE_SERIAL_KEY, serial);
  } catch {
    /* ignore */
  }
  return serial;
}
