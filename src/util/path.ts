import { join } from "node:path";
import { basename } from "node:path";

/** Build remote path: `<remoteDir>/<filename>` with normalized separators. */
export function buildRemotePath(remoteDir: string, filePath: string): string {
  const dir = remoteDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const name = basename(filePath);
  return dir ? `${dir}/${name}` : name;
}

export function resolveLocalPath(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return join(home, p.slice(1).replace(/^[\\/]/, ""));
  }
  return p;
}
