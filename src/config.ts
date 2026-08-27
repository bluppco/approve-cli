import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthTokens, AuthUser } from "./api-client.js";

export type StoredCredentials = {
  version: 2;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user?: AuthUser;
};

type LegacyStoredCredentials = Omit<StoredCredentials, "version"> & {
  version: 1;
  projectUrl?: string;
};

export type StoredSelection = {
  id: string;
  slug: string;
  name: string;
};

export type StoredContext = {
  version: 1;
  workspace?: StoredSelection;
  project?: StoredSelection;
};

function defaultConfigDir(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.APPROVE_CONFIG_DIR) return environment.APPROVE_CONFIG_DIR;
  if (process.platform === "win32") return join(environment.APPDATA || join(homedir(), "AppData", "Roaming"), "Approve");
  return join(environment.XDG_CONFIG_HOME || join(homedir(), ".config"), "approve");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export class CliConfigStore {
  readonly directory: string;
  readonly credentialsPath: string;
  readonly contextPath: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.directory = defaultConfigDir(environment);
    this.credentialsPath = join(this.directory, "credentials.json");
    this.contextPath = join(this.directory, "config.json");
  }

  readCredentials() {
    const value = readJson<StoredCredentials | LegacyStoredCredentials>(this.credentialsPath);
    if (!value || !value.accessToken || !value.refreshToken || (value.version !== 1 && value.version !== 2)) return null;
    return {
      version: 2,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      tokenType: value.tokenType,
      expiresIn: value.expiresIn,
      ...(value.user ? { user: value.user } : {}),
    } satisfies StoredCredentials;
  }

  writeTokens(tokens: AuthTokens) {
    atomicJson(this.credentialsPath, {
      version: 2,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
      expiresIn: tokens.expires_in,
      ...(tokens.user ? { user: tokens.user } : {}),
    } satisfies StoredCredentials);
  }

  clearCredentials() {
    if (existsSync(this.credentialsPath)) unlinkSync(this.credentialsPath);
  }

  readContext() {
    const value = readJson<StoredContext>(this.contextPath);
    return value?.version === 1 ? value : { version: 1 as const };
  }

  writeContext(value: StoredContext) {
    atomicJson(this.contextPath, value);
  }

  clearContext() {
    if (existsSync(this.contextPath)) unlinkSync(this.contextPath);
  }
}
