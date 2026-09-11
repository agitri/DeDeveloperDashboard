/**
 * Containers, grouped by the project they belong to. Port of
 * `dev/containers.rs`.
 *
 * Docker Compose labels every container it starts with
 * `com.docker.compose.project.working_dir` — the absolute path of the directory
 * the compose file was run from. That is a direct join key to a project on
 * disk, which is what lets a row for "the server on 3000" expand into the
 * containers that server talks to.
 *
 * Shelling out to `docker` rather than speaking to the socket: this runs once
 * per refresh at most, the CLI handles context selection, and a missing Docker
 * must be an empty list rather than an error.
 */
import { execFileRunner, lines, type Runner } from "./run";

export interface DevContainer {
  name: string;
  /** The compose project name. Usually the directory's basename, but not
   *  always — and when it differs, this is the name the containers themselves
   *  are prefixed with, so it is the one a human recognises. */
  project: string;
  /** `running`, `exited (255)`, `restarting` — verbatim from Docker. */
  status: string;
  /** True only for `Up …`. Anything else, including `restarting`, is not. */
  running: boolean;
  /** Whether Docker's own healthcheck is failing, when the image defines one. */
  unhealthy: boolean;
  /** Host ports this container publishes, for the port-conflict question. */
  ports: number[];
}

// Tab-separated rather than JSON: one format string, no parser, and container
// names cannot contain tabs.
const FORMAT = [
  '{{.Label "com.docker.compose.project.working_dir"}}',
  "{{.Names}}",
  "{{.Status}}",
  "{{.Ports}}",
  '{{.Label "com.docker.compose.project"}}',
].join("\t");

export const DOCKER_ARGS = ["ps", "--all", "--filter", "label=com.docker.compose.project", "--format", FORMAT];

/** Containers keyed by the project directory they were composed from.
 *
 *  Never rejects: no Docker, no daemon, or a permission problem all mean the
 *  same thing to a caller — no containers to show. */
export async function byProjectDir(runner: Runner = execFileRunner): Promise<Map<string, DevContainer[]>> {
  const out = await runner("docker", DOCKER_ARGS);
  return parse(out.stdout);
}

export function parse(output: string): Map<string, DevContainer[]> {
  const out = new Map<string, DevContainer[]>();
  for (const line of lines(output)) {
    const parts = line.split("\t");
    const [rawDir, rawName, rawStatus] = parts;
    if (rawDir === undefined || rawName === undefined || rawStatus === undefined) continue;
    const dir = rawDir.trim();
    if (dir === "" || rawName.trim() === "") continue;
    const ports = parts[3] === undefined ? [] : parsePorts(parts[3]);
    // Older output, and any hand-written fixture, may stop at the ports. The
    // directory's basename is the same answer in the common case.
    const labelled = parts[4]?.trim();
    const project = labelled !== undefined && labelled !== "" ? labelled : leaf(dir);
    const list = out.get(dir) ?? [];
    list.push({
      name: rawName.trim(),
      project,
      status: rawStatus.trim(),
      // "Up 5 months (unhealthy)" is running; "Restarting" is not, because a
      // crash-looping container is not something you can use.
      running: rawStatus.trimStart().startsWith("Up"),
      unhealthy: rawStatus.includes("unhealthy"),
      ports,
    });
    out.set(dir, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** `0.0.0.0:3306->3306/tcp, [::]:3306->3306/tcp` → `[3306]`.
 *
 *  Host ports only — the left side of the arrow. A container's internal port is
 *  not something anything on this machine can collide with. */
export function parsePorts(ports: string): number[] {
  const found: number[] = [];
  for (const mapping of ports.split(",")) {
    const host = mapping.split("->")[0]!;
    const last = host.slice(host.lastIndexOf(":") + 1).trim();
    // Rust parses a u16 here, so `3306/tcp` (exposed, not published) fails.
    if (!/^\d+$/.test(last)) continue;
    const port = Number(last);
    if (port > 65535 || found.includes(port)) continue;
    found.push(port);
  }
  return found.sort((a, b) => a - b);
}

function leaf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}
