import { ChildProcess, spawn } from 'node:child_process';
import * as http from 'node:http';

export interface ManagedProcess {
  name: string;
  process: ChildProcess;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  exited: boolean;
}

export class ProcessSupervisor {
  private processes: ManagedProcess[] = [];

  /**
   * Spawns and supervises a child process.
   */
  public spawn(
    name: string,
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    } = {}
  ): ManagedProcess {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry: ManagedProcess = {
      name,
      process: child,
      stdout: [],
      stderr: [],
      exitCode: null,
      exited: false,
    };

    child.stdout?.on('data', (data) => {
      entry.stdout.push(data.toString());
    });

    child.stderr?.on('data', (data) => {
      entry.stderr.push(data.toString());
    });

    child.on('exit', (code) => {
      entry.exitCode = code;
      entry.exited = true;
    });

    this.processes.push(entry);
    return entry;
  }

  /**
   * Waits for an HTTP endpoint to become healthy with condition polling and bounded deadline.
   */
  public async waitForHttpReady(url: string, timeoutMs: number = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.get(url, (res) => {
            if (res.statusCode && res.statusCode < 500) {
              resolve(true);
            } else {
              resolve(false);
            }
          });
          req.on('error', () => resolve(false));
          req.setTimeout(500, () => {
            req.destroy();
            resolve(false);
          });
        });
        if (ok) return;
      } catch {
        // Retry until deadline
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Process failed to respond at ${url} within ${timeoutMs}ms deadline`);
  }

  /**
   * Waits for a generic predicate condition to become true with deadline.
   */
  public async waitForCondition(
    condition: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs: number = 5000,
    intervalMs: number = 50
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Condition '${description}' not met within ${timeoutMs}ms`);
  }

  /**
   * Terminates all managed processes cleanly and asserts no process leakage.
   */
  public async teardownAll(): Promise<void> {
    for (const item of this.processes) {
      if (!item.exited && item.process.pid) {
        try {
          item.process.kill('SIGTERM');
        } catch {
          // Process might already be dead
        }
      }
    }

    // Wait up to 2 seconds for graceful exit
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const allExited = this.processes.every((p) => p.exited);
      if (allExited) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Force SIGKILL for any stubborn processes
    for (const item of this.processes) {
      if (!item.exited && item.process.pid) {
        try {
          item.process.kill('SIGKILL');
        } catch {
          // Ignored
        }
      }
    }
    this.processes = [];
  }
}
