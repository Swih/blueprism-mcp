import { CredentialsError } from "./errors.js";

/** Blue Prism native login. */
export interface BpCredentials {
  readonly user: string;
  readonly password: string;
}

/** Where the bridge gets its Blue Prism login from. Asked once per command. */
export interface CredentialProvider {
  getCredentials(): Promise<BpCredentials>;
}

/**
 * Reads `BP_USER` and `BP_PASSWORD` from the environment (by default `process.env`). Throws
 * {@link CredentialsError} naming the missing variables, never their values.
 */
export class EnvCredentialProvider implements CredentialProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getCredentials(): Promise<BpCredentials> {
    const user = this.env.BP_USER ?? "";
    const password = this.env.BP_PASSWORD ?? "";
    const missing = [user === "" && "BP_USER", password === "" && "BP_PASSWORD"].filter(Boolean);
    if (missing.length > 0) {
      return Promise.reject(
        new CredentialsError(`Missing Blue Prism credentials: set ${missing.join(" and ")}`),
      );
    }
    return Promise.resolve({ user, password });
  }
}
