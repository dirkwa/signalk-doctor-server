import { readFile } from 'node:fs/promises';
import type { ProbeResult } from './types.js';

// Host-mounted by the doctor quadlet (see signalk-universal-installer
// quadlets/signalk-doctor-server.container.template). Read per-call so tests
// can override via env without bouncing the module — runtime cost negligible.
const cgroupRoot = (): string => process.env.HOST_CGROUP_ROOT ?? '/host/cgroup';
const cmdlinePath = (): string => process.env.HOST_CMDLINE_PATH ?? '/host/proc/cmdline';

// Operator UID — same UID the doctor runs as under rootless podman.
const OPERATOR_UID = process.getuid?.() ?? 0;

const REQUIRED_CONTROLLERS = ['memory', 'pids'] as const;

// Verbatim from signalk-universal-installer installer/linux/preflight.sh:97-100
// (when cgroup_disable=memory is present) and :103-106 (generic). Kept as
// constants so future installer changes can be mirrored here mechanically.
const RECIPE_CMDLINE_REMOVE_DISABLE = [
  'sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak.$(date +%Y%m%d)',
  "sudo sed -i 's/\\bcgroup_disable=memory\\b//; s/$/ cgroup_enable=memory cgroup_memory=1/' /boot/firmware/cmdline.txt",
  '# /boot/firmware/cmdline.txt must remain a single line — verify: awk "END{print NR}" /boot/firmware/cmdline.txt',
  'sudo reboot',
].join('\n');

const RECIPE_CMDLINE_APPEND = [
  'sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak.$(date +%Y%m%d)',
  "sudo sed -i 's/$/ cgroup_enable=memory cgroup_memory=1/' /boot/firmware/cmdline.txt",
  '# /boot/firmware/cmdline.txt must remain a single line — verify: awk "END{print NR}" /boot/firmware/cmdline.txt',
  'sudo reboot',
].join('\n');

// Verbatim from install.sh:413-419.
const RECIPE_USER_SLICE_DELEGATION = [
  'sudo install -d -m 0755 /etc/systemd/system/user@.service.d',
  "sudo tee /etc/systemd/system/user@.service.d/delegate.conf >/dev/null <<'EOF'",
  '[Service]',
  'Delegate=cpu cpuset io memory pids',
  'EOF',
  'sudo systemctl daemon-reload',
  'sudo reboot   # daemon-reload alone does NOT re-apply Delegate= to running user@.service',
].join('\n');

const LABEL = 'cgroup controller delegation';

async function readControllers(path: string): Promise<string[] | null> {
  try {
    const contents = await readFile(path, 'utf-8');
    return contents.trim().split(/\s+/);
  } catch {
    return null;
  }
}

function missing(controllers: string[]): string[] {
  return REQUIRED_CONTROLLERS.filter((c) => !controllers.includes(c));
}

export async function probeCgroupDelegation(): Promise<ProbeResult> {
  const t0 = Date.now();
  const root = cgroupRoot();

  const rootControllers = await readControllers(`${root}/cgroup.controllers`);
  if (rootControllers === null) {
    // No /host/cgroup mount — operator is on an older quadlet that
    // predates this probe. Non-blocking advisory.
    return {
      id: 'cgroup-delegation',
      label: LABEL,
      status: 'unknown',
      message: `${root}/cgroup.controllers not readable — doctor container is missing the host cgroup mount; refresh the doctor quadlet via signalk-universal-installer to enable this probe`,
      durationMs: Date.now() - t0,
    };
  }

  const rootMissing = missing(rootControllers);
  if (rootMissing.length > 0) {
    // Layer 1 fail — controllers not enabled at the kernel root cgroup.
    // Distinguish the Pi-OS-Trixie firmware-injection case (verbatim
    // mirror of preflight.sh:89-100) from the generic missing-controller
    // case (preflight.sh:101-106).
    let kernelCmdlineHasDisableMemory = false;
    try {
      const cmdline = await readFile(cmdlinePath(), 'utf-8');
      kernelCmdlineHasDisableMemory = /\bcgroup_disable=memory\b/.test(cmdline);
    } catch {
      // /proc/cmdline not mounted — fall through with the generic recipe.
    }

    const remedy = kernelCmdlineHasDisableMemory
      ? RECIPE_CMDLINE_REMOVE_DISABLE
      : RECIPE_CMDLINE_APPEND;
    const why = kernelCmdlineHasDisableMemory
      ? `kernel cmdline contains 'cgroup_disable=memory' (typically injected by Raspberry Pi GPU firmware on Trixie)`
      : `controller(s) ${rootMissing.join(', ')} not present at root cgroup`;

    return {
      id: 'cgroup-delegation',
      label: LABEL,
      status: 'fail',
      message: `Layer 1 — ${why}. Container resource limits will silently no-op. Remediation:\n${remedy}`,
      details: {
        layer: 1,
        rootControllers,
        rootMissing,
        kernelCmdlineHasDisableMemory,
        remedy,
      },
      durationMs: Date.now() - t0,
    };
  }

  const userSlicePath = `${root}/user.slice/user-${OPERATOR_UID}.slice/cgroup.controllers`;
  const userControllers = await readControllers(userSlicePath);
  if (userControllers === null) {
    // Root passes but user slice isn't materialised yet (linger off, or
    // doctor started before login). The doctor itself runs under that
    // slice, so this is unusual — surface it as unknown.
    return {
      id: 'cgroup-delegation',
      label: LABEL,
      status: 'unknown',
      message: `Root cgroup OK (${rootControllers.join(', ')}) but ${userSlicePath} not readable — user slice not materialised yet`,
      details: { layer: 2, rootControllers, userSlicePath },
      durationMs: Date.now() - t0,
    };
  }

  const userMissing = missing(userControllers);
  if (userMissing.length > 0) {
    return {
      id: 'cgroup-delegation',
      label: LABEL,
      status: 'warn',
      message: `Layer 2 — user-${OPERATOR_UID}.slice missing delegated controller(s) ${userMissing.join(', ')}. Container resource limits will silently no-op. Remediation:\n${RECIPE_USER_SLICE_DELEGATION}`,
      details: {
        layer: 2,
        rootControllers,
        userControllers,
        userMissing,
        remedy: RECIPE_USER_SLICE_DELEGATION,
      },
      durationMs: Date.now() - t0,
    };
  }

  return {
    id: 'cgroup-delegation',
    label: LABEL,
    status: 'ok',
    message: `both layers OK (root: ${rootControllers.join(' ')} | user-${OPERATOR_UID}.slice: ${userControllers.join(' ')})`,
    details: { layer: 0, rootControllers, userControllers },
    durationMs: Date.now() - t0,
  };
}
