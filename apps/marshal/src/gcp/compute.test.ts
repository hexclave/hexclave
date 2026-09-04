import { describe, expect, it } from "vitest";
import { builderStartupScript, serviceStartupScript } from "./compute.js";

describe("Compute Engine startup scripts", () => {
  it("quotes tenant values and keeps persistent disks non-auto-deleting", () => {
    const script = serviceStartupScript({
      name: "server",
      image: "docker.io/library/nginx:latest",
      env: { SAFE: "value with spaces", QUOTE: "don't expand $HOME" },
      ports: [8080, 9000],
      revision: "revision-1",
      startCommand: "node server.js",
      volume: { diskName: "hxv-data", path: "/data" },
      serviceKeyHash: "service-key",
    });
    expect(script).toContain("google-hxv-data");
    expect(script).toContain('resize2fs "$DATA_DEVICE"');
    expect(script).toContain("'QUOTE=don'\"'\"'t expand $HOME'");
    // Must be under /mnt/disks: COS's root filesystem is read-only, so any other mount point
    // fails mkdir and kills the whole `set -e` startup script before the container starts.
    expect(script).toContain("'--mount' 'type=bind,src=/mnt/disks/hexclave-data,dst=/data'");
    expect(script).toContain("mkdir -p /mnt/disks/hexclave-data");
    expect(script).toContain("'--log-driver=gcplogs'");
    expect(script).toContain("MARSHAL_SERVICE_READY $REVISION");
    expect(script).toContain("docker inspect --format '{{.State.Running}}' marshal-service");
    expect(script).toContain("probe_port 8080");
    expect(script).toContain("probe_port 9000");
    // Container-Optimized OS ships a bash built without --enable-net-redirections, so a
    // /dev/tcp redirection there is a literal path, not a socket: the readiness gate could
    // never pass and every server deploy failed. Assert the shape is gone, not just that the
    // replacement is present.
    expect(script).not.toContain("/dev/tcp/");
    expect(script.indexOf("MARSHAL_SERVICE_NOT_READY")).toBeLessThan(script.indexOf("MARSHAL_SERVICE_READY $REVISION"));
    expect(script).toContain("MARSHAL_IMAGE_REF $RESOLVED_IMAGE");
    expect(script).not.toContain("configure-docker");
  });

  it("configures the credential helper only for Google container registries", () => {
    const script = serviceStartupScript({
      name: "server",
      image: "us-central1-docker.pkg.dev/tenant/marshal/web:latest",
      env: {},
      ports: [8080],
      revision: "revision-1",
      startCommand: null,
      volume: null,
      serviceKeyHash: "service-key",
    });
    expect(script).toContain("docker-credential-gcr configure-docker");
    expect(script).toContain("us-central1-docker.pkg.dev");
    // The credential helper defaults to $HOME/.docker — /root/.docker here — but COS mounts /
    // read-only, so that mkdir fails and set -e kills the script before any container runs.
    // Only a Google registry reaches this branch, which is why a live test that deploys
    // public docker.io images cannot catch it.
    expect(script).toContain("export DOCKER_CONFIG=/var/lib/marshal-home/.docker");
    expect(script).not.toContain("/root/.docker");
  });

  it("obtains short-lived registry credentials from metadata instead of embedding a key", () => {
    const script = builderStartupScript({
      name: "builder",
      image: "moby/buildkit:v0.23.2",
      machineType: "e2-standard-2",
      diskSizeGb: 30,
      files: [{ path: "/marshal-build.sh", contentsBase64: "c2NyaXB0" }],
      env: { REGISTRY_HOST: "us-central1-docker.pkg.dev" },
    });
    expect(script).toContain("metadata.google.internal");
    expect(script).toContain("oauth2accesstoken");
    expect(script).toContain("iptables -I OUTPUT -d 169.254.169.254/32 -p tcp --dport 80 -j REJECT");
    expect(script).toContain("iptables -I DOCKER-USER -d 169.254.169.254/32 -p tcp --dport 80 -j REJECT");
    expect(script.indexOf("iptables -I OUTPUT")).toBeLessThan(script.indexOf("docker pull"));
    // The metadata address doubles as the DNS resolver on Container-Optimized OS. Blocking it
    // wholesale kills name resolution for every pull, fetch and push the build has to make, so
    // the rules must stay scoped to the metadata API's port.
    expect(script).not.toContain("169.254.169.254/32 -j REJECT");
    expect(script).not.toContain("private_key");
    expect(script).not.toContain("instances/$INSTANCE_NAME");
    expect(script).toContain("shutdown -h now");
  });
});
