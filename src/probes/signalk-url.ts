// Where the doctor reaches signalk-server. Resolved at call time (not
// module load) so tests can swap the env between runs and so the
// installer can override via the engine's Quadlet without rebuilding.
//
// 127.0.0.1 is wrong from inside this container — the doctor runs in its
// own netns, so loopback never reaches signalk-server. Podman wires
// `host.containers.internal` into /etc/hosts as the host gateway; that
// works whether signalk-server uses Network=host or a PublishPort.
//
// The installer templates SIGNALK_URL / SIGNALK_HTTPS_URL into the
// doctor Quadlet from the chosen SK_HTTP_PORT / SK_HTTPS_PORT. The
// default HTTP port is 80 (the installer's privileged-ports default);
// HTTPS has no default because signalk-server only serves TLS once the
// operator enables it (e.g. via signalk-ssl) — absent that, there's
// nothing on the HTTPS port and a fallback attempt would be noise.

/** Plain-HTTP signalk-server endpoint. */
export function signalkHttpUrl(): string {
  return process.env.SIGNALK_URL ?? 'http://host.containers.internal:80/signalk';
}

/** HTTPS endpoint signalk-server redirects to when SSL is enabled, or
 *  `null` when the installer didn't inject one (so the probe makes no
 *  HTTPS attempt). */
export function signalkHttpsUrl(): string | null {
  return process.env.SIGNALK_HTTPS_URL ?? null;
}
