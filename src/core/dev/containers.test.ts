import { describe, expect, it } from "vitest";
import { DOCKER_ARGS, byProjectDir, parse, parsePorts } from "./containers";
import type { Runner } from "./run";

/** Real `docker ps` output in the format below: working dir, name, status,
 *  ports, compose project — tab separated. */
const REAL =
  "/Users/rene/Projects/climate4u\tclimate4u-database-1\tUp 2 hours\t0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp\n" +
  "/Users/rene/Projects/climate4u\tclimate4u-redis-1\tUp 2 hours (healthy)\t\n" +
  "/Users/rene/Projects/firstklas\tfirstklas-traefik-1\tUp 5 months (unhealthy)\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" +
  "/Users/rene/Projects/old\told-api-1\tExited (255) 5 months ago\t\n";

describe("docker containers", () => {
  it("groups containers by the project they were composed from", () => {
    const byDir = parse(REAL);
    expect(byDir.size).toBe(3);
    expect(byDir.get("/Users/rene/Projects/climate4u")).toHaveLength(2);
  });

  it("treats running and unhealthy as separate facts", () => {
    const byDir = parse(REAL);
    const traefik = byDir.get("/Users/rene/Projects/firstklas")![0]!;
    // The real case this came from: up for five months *and* failing its
    // healthcheck. Collapsing the two would have hidden it.
    expect(traefik.running).toBe(true);
    expect(traefik.unhealthy).toBe(true);

    const exited = byDir.get("/Users/rene/Projects/old")![0]!;
    expect(exited.running).toBe(false);
    expect(exited.unhealthy).toBe(false);
  });

  it("does not call a restarting container running", () => {
    // Crash-looping is not a state you can use, and "Restarting" does not start
    // with "Up" — asserted so a later loosening cannot call it running.
    expect(parse("/p\tapi-1\tRestarting (1) 3 seconds ago\t\n").get("/p")![0]!.running).toBe(false);
  });

  it("reads host ports and ignores container ports", () => {
    const byDir = parse(REAL);
    expect(byDir.get("/Users/rene/Projects/climate4u")![0]!.ports).toEqual([5433]);
    // Both families publish the same host port; it is one port, not two.
    expect(byDir.get("/Users/rene/Projects/firstklas")![0]!.ports).toEqual([80, 443]);
    // An exposed-but-unpublished port has no host side and is not a collision.
    expect(parsePorts("3306/tcp")).toEqual([]);
    expect(parsePorts("")).toEqual([]);
  });

  it("gives a container with no published ports none", () => {
    expect(parse(REAL).get("/Users/rene/Projects/climate4u")![1]!.ports).toEqual([]);
  });

  it("skips a container without the label rather than grouping it under the empty string", () => {
    // `--filter` should prevent this, but an unlabelled row must never create a
    // project keyed on "".
    expect(parse("\tstray-1\tUp 2 hours\t\n").size).toBe(0);
  });

  it("does not let a malformed line take the rest with it", () => {
    expect(parse("garbage\n/p\tapi-1\tUp\t\n").size).toBe(1);
  });

  it("names the compose project from the label, falling back to the directory's basename", () => {
    const labelled = parse("/Users/rene/Projects/onderwijscatalogus/backend\tonderwijscatalogus-nginx-1\tUp\t\tonderwijscatalogus\n");
    expect(labelled.get("/Users/rene/Projects/onderwijscatalogus/backend")![0]!.project).toBe("onderwijscatalogus");
    // Older output, and any hand-written fixture, may stop at the ports.
    expect(parse(REAL).get("/Users/rene/Projects/climate4u")![0]!.project).toBe("climate4u");
  });

  it("sorts each project's containers by name", () => {
    const byDir = parse("/p\tb-1\tUp\t\n/p\ta-1\tUp\t\n");
    expect(byDir.get("/p")!.map((c) => c.name)).toEqual(["a-1", "b-1"]);
  });

  it("runs one docker ps with the format the parser expects, and finds nothing when Docker is absent", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: REAL, ok: true };
    };
    expect((await byProjectDir(runner)).size).toBe(3);
    expect(calls).toEqual([
      [
        "docker",
        "ps",
        "--all",
        "--filter",
        "label=com.docker.compose.project",
        "--format",
        '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}',
      ],
    ]);
    expect(DOCKER_ARGS[0]).toBe("ps");

    // No Docker, no daemon, or a permission problem all mean the same thing: a
    // dashboard that fails to render because Docker is not installed would be
    // absurd.
    expect((await byProjectDir(async () => ({ stdout: "", ok: false }))).size).toBe(0);
  });
});
