import { describe, it, expect } from 'vitest';
import { probeMemory } from '../src/probes/memory.js';
import { probeDisk } from '../src/probes/disk.js';
import { probeDbus } from '../src/probes/dbus.js';

describe('probes — host-side', () => {
  it('memory probe always returns a result', async () => {
    const r = await probeMemory();
    expect(['ok', 'warn', 'fail']).toContain(r.status);
    expect(r.id).toBe('memory');
    expect(typeof r.message).toBe('string');
    expect(r.details).toBeDefined();
  });

  it('disk probe never throws', async () => {
    const r = await probeDisk();
    expect(['ok', 'warn', 'fail', 'unknown']).toContain(r.status);
    expect(r.id).toBe('disk');
  });

  it('dbus probe reports fail when /host/dbus is missing (default)', async () => {
    // /host/dbus is the in-container mount; outside the container it does not exist.
    const r = await probeDbus();
    expect(r.status).toBe('fail');
    expect(r.id).toBe('dbus');
  });
});
