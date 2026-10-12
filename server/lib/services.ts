/**
 * Start / inspect the XAMPP services without making the user open the XAMPP
 * control panel. Both services are launched detached and unref'd so they
 * outlive this Node process, matching what apache_start.bat / mysql_start.bat do.
 */
import { spawn } from "node:child_process";
import { execa } from "execa";
import { XAMPP } from "./env.ts";

export type ServiceName = "apache" | "mariadb";

const PROCESS_IMAGE: Record<ServiceName, string> = {
  apache: "httpd.exe",
  mariadb: "mysqld.exe",
};

/** True when at least one process with the service's image name is running. */
export async function isServiceRunning(name: ServiceName): Promise<boolean> {
  const image = PROCESS_IMAGE[name];
  try {
    const { stdout } = await execa(
      "tasklist",
      ["/FI", `IMAGENAME eq ${image}`, "/NH"],
      { reject: false },
    );
    return stdout.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Launch a service detached. Resolves once the process is observable in
 * tasklist, or rejects after `timeoutMs` so the UI never hangs forever.
 */
export async function startService(
  name: ServiceName,
  timeoutMs = 20_000,
): Promise<void> {
  if (await isServiceRunning(name)) return;

  const [command, args] =
    name === "apache"
      ? [XAMPP.httpd, [] as string[]]
      : [XAMPP.mysqld, ["--defaults-file=" + XAMPP.myIni, "--standalone"]];

  const child = spawn(command, args, {
    cwd: XAMPP.root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isServiceRunning(name)) return;
  }
  throw new Error(
    `${name} did not come up within ${timeoutMs / 1000}s. ` +
      `Try starting it manually from ${XAMPP.controlPanel}.`,
  );
}

/** Verify MariaDB actually accepts connections, not merely that it booted. */
export async function canConnectToDatabase(): Promise<boolean> {
  try {
    const result = await execa(
      XAMPP.mysql,
      ["-u", "root", "-e", "SELECT 1"],
      { reject: false, timeout: 10_000 },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
