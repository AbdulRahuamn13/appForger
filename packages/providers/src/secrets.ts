import { Entry } from "@napi-rs/keyring";

/** Names of the API keys AppForge can store. Subscription logins are never stored. */
export const SECRET_NAMES = ["anthropic-api-key", "openai-api-key", "s3-access-key-id", "s3-secret-access-key"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Environment variables accepted as a read-only fallback (useful where no keychain exists). */
export const SECRET_ENV: Record<SecretName, string> = {
  "anthropic-api-key": "ANTHROPIC_API_KEY",
  "openai-api-key": "OPENAI_API_KEY",
  "s3-access-key-id": "AWS_ACCESS_KEY_ID",
  "s3-secret-access-key": "AWS_SECRET_ACCESS_KEY",
};

export interface SecretStatus {
  present: boolean;
  source?: "keychain" | "env";
  /** Set when the OS keychain could not be reached. */
  keychainError?: string;
}

export interface SecretStore {
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  status(name: SecretName): Promise<SecretStatus>;
}

const SERVICE = "appforge";

/**
 * API keys live in the OS keychain (macOS Keychain, Windows Credential
 * Manager, Secret Service on Linux) — never in files, logs, or the DB.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly service = SERVICE) {}

  private entry(name: SecretName): Entry {
    return new Entry(this.service, name);
  }

  async get(name: SecretName): Promise<string | undefined> {
    try {
      const value = this.entry(name).getPassword();
      if (value) return value;
    } catch {
      // keychain unavailable or no entry; fall back to env
    }
    return process.env[SECRET_ENV[name]] || undefined;
  }

  async set(name: SecretName, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Key is empty");
    try {
      this.entry(name).setPassword(trimmed);
    } catch (err) {
      throw new Error(`Could not write to the OS keychain: ${(err as Error).message}. Set ${SECRET_ENV[name]} in AppForge's environment instead.`, { cause: err });
    }
  }

  async delete(name: SecretName): Promise<void> {
    try {
      this.entry(name).deletePassword();
    } catch {
      // nothing stored
    }
  }

  async status(name: SecretName): Promise<SecretStatus> {
    let keychainError: string | undefined;
    try {
      if (this.entry(name).getPassword()) return { present: true, source: "keychain" };
    } catch (err) {
      const message = (err as Error).message;
      // "no entry" is normal; anything else means the keychain itself is unavailable.
      if (!/no (matching )?entry|not found/i.test(message)) keychainError = message;
    }
    if (process.env[SECRET_ENV[name]]) return { present: true, source: "env", ...(keychainError ? { keychainError } : {}) };
    return keychainError ? { present: false, keychainError } : { present: false };
  }
}

/** For tests. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<SecretName, string>();

  async get(name: SecretName): Promise<string | undefined> {
    return this.values.get(name);
  }
  async set(name: SecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: SecretName): Promise<void> {
    this.values.delete(name);
  }
  async status(name: SecretName): Promise<SecretStatus> {
    return this.values.has(name) ? { present: true, source: "keychain" } : { present: false };
  }
}
