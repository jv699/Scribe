// Guards the final path component; stores remain responsible for path confinement.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";

export async function openRegularFileNoFollow(
  path: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  const file = await open(path, flags | constants.O_NOFOLLOW, mode);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("target is not a regular file");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readRegularFileNoFollow(path: string): Promise<string> {
  // Avoid blocking if a discovered file was replaced with a FIFO.
  const file = await openRegularFileNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function isDirectoryNoFollow(path: string): Promise<boolean> {
  const stats = await lstat(path);
  return stats.isDirectory() && !stats.isSymbolicLink();
}

/**
 * Atomically replace a file via an exclusively-created sibling temporary.
 * Returns false when the immediate parent is not a real directory.
 */
export async function atomicReplaceRegularFile(path: string, content: string): Promise<boolean> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  if (!(await isDirectoryNoFollow(parent))) return false;

  const temporary = join(parent, `.${basename(path)}.${process.pid}-${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  try {
    file = await openRegularFileNoFollow(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o666,
    );
    await file.writeFile(content, "utf8");
    await file.close();
    file = undefined;

    // rename replaces a destination symlink instead of following it.
    await rename(temporary, path);
    return true;
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}
