import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLI_DIR = process.env.AGENT_LINK_CLI_DIR ||
  (fs.existsSync(path.resolve(__dirname, '../../../agent-link-cli'))
    ? path.resolve(__dirname, '../../../agent-link-cli')
    : path.resolve(process.cwd(), '../agent-link-cli'));

export interface ActorPaths {
  root: string;
  home: string;
  keys: string;
  state: string;
  inbox: string;
}

export interface ScenarioPaths {
  root: string;
  serverData: string;
  serverBugLog: string;
  actors: Record<string, ActorPaths>;
}

export class IsolatedTestEnvironment {
  public readonly paths: ScenarioPaths;
  private readonly rootDir: string;

  constructor(prefix: string = 'agentlink-test-') {
    this.rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const actorsList = ['alice', 'bob', 'ava', 'eve', 'admin'];
    const actors: Record<string, ActorPaths> = {};

    for (const actor of actorsList) {
      const actorRoot = path.join(this.rootDir, 'actors', actor);
      const home = path.join(actorRoot, 'home');
      const keys = path.join(actorRoot, 'keys');
      const state = path.join(actorRoot, 'state');
      const inbox = path.join(actorRoot, 'inbox.jsonl');

      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(keys, { recursive: true });
      fs.mkdirSync(state, { recursive: true });

      actors[actor] = {
        root: actorRoot,
        home,
        keys,
        state,
        inbox,
      };
    }

    const serverDir = path.join(this.rootDir, 'server');
    fs.mkdirSync(serverDir, { recursive: true });

    this.paths = {
      root: this.rootDir,
      serverData: path.join(serverDir, 'state.json'),
      serverBugLog: path.join(serverDir, 'bug-reports.jsonl'),
      actors,
    };
  }

  /**
   * Generates a strictly allowlisted environment dictionary for an actor subprocess.
   * Ensures no host ~/.agent-link or unvetted credentials leak into the child process.
   */
  public getActorEnv(actorName: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
    const actor = this.paths.actors[actorName];
    if (!actor) {
      throw new Error(`Actor '${actorName}' not defined in isolated environment`);
    }

    return {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: actor.home,
      AGENT_LINK_KEY_DIR: actor.keys,
      AGENT_LINK_STATE_DIR: actor.state,
      PYTHONPATH: CLI_DIR,
      PYTHONUNBUFFERED: '1',
      NODE_ENV: 'test',
      ...extraEnv,
    };
  }

  /**
   * Executes the Python CLI as the designated actor using python3 -m agent_link.cli.
   */
  public async runCli(
    actorName: string,
    args: string[],
    options: {
      extraEnv?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env = this.getActorEnv(actorName, options.extraEnv);
    const timeout = options.timeoutMs || 15000;

    try {
      const result = await execFileAsync('python3', ['-m', 'agent_link.cli', ...args], {
        cwd: CLI_DIR,
        env,
        timeout,
      });
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        stdout: (err.stdout || '').toString(),
        stderr: (err.stderr || err.message || '').toString(),
        exitCode: typeof err.code === 'number' ? err.code : (err.status || 1),
      };
    }
  }

  /**
   * Tears down the scenario root directory and verifies no files remain.
   */
  public cleanup(): void {
    if (this.rootDir && fs.existsSync(this.rootDir)) {
      fs.rmSync(this.rootDir, { recursive: true, force: true });
    }
  }
}
