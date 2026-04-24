import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BOOKSHOP_DIR = path.join(__dirname, '..', 'bookshop');
export const SIDECAR_DIR = path.join(BOOKSHOP_DIR, 'mtx', 'sidecar');
export const ROOT_DIR = path.join(__dirname, '..', '..');

/**
 * Pack @cap-js/ai and install in sidecar to avoid dual @sap/cds load.
 * Restores the original package.json afterward so the file: reference stays intact.
 */
export function ensureSidecarPlugin() {
  const pkgPath = path.join(SIDECAR_DIR, 'package.json');
  const originalPkg = fs.readFileSync(pkgPath, 'utf-8');
  const tmpDir = os.tmpdir();
  const tgz = execSync(`npm pack --pack-destination ${tmpDir}`, {
    cwd: ROOT_DIR,
    encoding: 'utf-8'
  }).trim();
  execSync(`npm install ${path.join(tmpDir, tgz)}`, {
    cwd: SIDECAR_DIR,
    encoding: 'utf-8',
    stdio: 'ignore'
  });
  fs.writeFileSync(pkgPath, originalPkg);
}

/**
 * Remove all db*.sqlite* files from bookshop root.
 */
export function cleanDbFiles() {
  let files;
  try {
    files = fs.readdirSync(BOOKSHOP_DIR);
  } catch {
    return;
  }
  for (const f of files.filter((f) => /^db.*\.sqlite(-shm|-wal)?$/.test(f))) {
    try {
      fs.unlinkSync(path.join(BOOKSHOP_DIR, f));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Start the MTX sidecar via `cds watch` on a random port.
 * Resolves with { proc, port } when the server is listening.
 */
export function startSidecar() {
  return new Promise((resolve, reject) => {
    const sidecarEnv = { ...process.env, FORCE_COLOR: '0' };
    // Strip HANA DB binding — sidecar uses sqlite for local tenant DBs.
    // Keep ai-core binding so the subscribe handler can create resource groups.
    if (sidecarEnv.VCAP_SERVICES) {
      try {
        const vcap = JSON.parse(sidecarEnv.VCAP_SERVICES);
        delete vcap.hana;
        delete vcap['hdi-shared'];
        sidecarEnv.VCAP_SERVICES = JSON.stringify(vcap);
      } catch {
        /* keep as-is */
      }
    }
    const proc = spawn('npx', ['cds', 'serve', '--port', '0'], {
      cwd: SIDECAR_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sidecarEnv,
      detached: true
    });

    let output = '';
    const timeout = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
      reject(new Error(`Sidecar failed to start within 60s.\nOutput: ${output}`));
    }, 60_000);

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    let started = false;
    function onData(data) {
      const chunk = data.toString();
      output += chunk;
      if (started) {
        process.stderr.write(`[sidecar] ${chunk}`);
        return;
      }
      const match = output.match(/server listening on \{[^}]*url:\s*'http:\/\/localhost:(\d+)'/);
      if (match) {
        started = true;
        clearTimeout(timeout);
        resolve({ proc, port: Number(match[1]) });
      }
    }

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`Sidecar exited with code ${code}.\nOutput: ${output}`));
      }
    });
  });
}

/**
 * Subscribe a tenant via the sidecar's SaaS Provisioning endpoint.
 */
export async function subscribeTenant(tenant, port) {
  const res = await fetch(`http://localhost:${port}/-/cds/saas-provisioning/tenant/${tenant}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from('yves:').toString('base64')
    },
    body: JSON.stringify({
      subscribedTenantId: tenant,
      subscribedSubdomain: tenant
    })
  });
  return res.status;
}

/**
 * Unsubscribe a tenant via the sidecar's SaaS Provisioning endpoint.
 */
export async function unsubscribeTenant(tenant, port) {
  const res = await fetch(`http://localhost:${port}/-/cds/saas-provisioning/tenant/${tenant}`, {
    method: 'DELETE',
    headers: {
      Authorization: 'Basic ' + Buffer.from('yves:').toString('base64')
    }
  });
  return res.status;
}

/**
 * Stop the sidecar process and clean up DB files.
 */
export async function stopSidecar(proc) {
  if (proc && !proc.killed) {
    if (proc.exitCode !== null) {
      // already exited
    } else {
      // Kill the entire process group (npx + cds serve + grandchildren)
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await Promise.race([
        new Promise((resolve) => proc.on('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
      // Force kill if still alive after 5s
      if (proc.exitCode === null) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }
  cleanDbFiles();
}
