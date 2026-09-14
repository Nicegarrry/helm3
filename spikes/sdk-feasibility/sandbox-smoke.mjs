import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const execAsync = promisify(exec);
const root = await mkdtemp(join(tmpdir(), "helm3-sandbox-smoke-"));
const allowed = join(root, "allowed");
const denied = join(root, "denied");
const unlisted = join(root, "unlisted");
const allowedFile = join(allowed, "permitted.txt");
const deniedFile = join(denied, "blocked.txt");
const unlistedFile = join(unlisted, "unlisted.txt");
const symlinkEscape = join(allowed, "escape");
await Promise.all([mkdir(allowed), mkdir(denied), mkdir(unlisted)]);
await symlink(unlisted, symlinkEscape);

const exists = async (path) => access(path).then(() => true).catch(() => false);
try {
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: [],
      allowWrite: [allowed],
      denyWrite: [denied],
    },
  });
  const allowedCommand = await SandboxManager.wrapWithSandbox(`touch '${allowedFile}'`);
  await execAsync(allowedCommand);
  const deniedCommand = await SandboxManager.wrapWithSandbox(`touch '${deniedFile}'`);
  let deniedExit = false;
  try {
    await execAsync(deniedCommand);
  } catch {
    deniedExit = true;
  }
  const unlistedCommand = await SandboxManager.wrapWithSandbox(`touch '${unlistedFile}'`);
  let unlistedExit = false;
  try {
    await execAsync(unlistedCommand);
  } catch {
    unlistedExit = true;
  }
  const symlinkCommand = await SandboxManager.wrapWithSandbox(`touch '${join(symlinkEscape, "symlink.txt")}'`);
  let symlinkExit = false;
  try {
    await execAsync(symlinkCommand);
  } catch {
    symlinkExit = true;
  }
  const result = {
    localOnly: true,
    allowedWriteCreated: await exists(allowedFile),
    deniedWriteRejected: deniedExit && !(await exists(deniedFile)),
    unlistedWriteRejected: unlistedExit && !(await exists(unlistedFile)),
    symlinkEscapeRejected: symlinkExit && !(await exists(join(unlisted, "symlink.txt"))),
  };
  assert.equal(result.allowedWriteCreated, true, "sandbox must allow the configured worktree write");
  assert.equal(result.deniedWriteRejected, true, "sandbox must reject the outside write");
  assert.equal(result.unlistedWriteRejected, true, "sandbox must deny an unlisted outside write");
  assert.equal(result.symlinkEscapeRejected, true, "sandbox must deny a symlink escape from the allowed worktree");
  console.log(JSON.stringify(result));
} finally {
  await SandboxManager.reset();
  await rm(root, { recursive: true, force: true });
}
