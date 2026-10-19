import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

interface Credentials {
  redirectUrl?: string | undefined;
  client?: StoredOAuthClientInformation | undefined;
  tokens?: StoredOAuthTokens | undefined;
  verifier?: string | undefined;
  discovery?: OAuthDiscoveryState | undefined;
}

/** Keep credentials outside the ordinary MCP configuration, in owner-only files. */
export class CustomMcpOAuthStore {
  private readonly directory: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "custom-mcp-oauth");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }
  private file(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid MCP server id");
    return path.join(this.directory, id + ".json");
  }
  load(id: string): Credentials {
    try {
      return JSON.parse(readFileSync(this.file(id), "utf8")) as Credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  patch(id: string, update: Partial<Credentials>): void {
    const file = this.file(id);
    const temp = file + "." + randomBytes(8).toString("hex");
    try {
      writeFileSync(temp, JSON.stringify({ ...this.load(id), ...update }), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, file);
      chmodSync(file, 0o600);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  clear(id: string): void {
    rmSync(this.file(id), { force: true });
  }
}

export class CustomMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  constructor(
    readonly serverId: string,
    private readonly store: CustomMcpOAuthStore,
    private readonly flowState?: string,
  ) {}
  get redirectUrl(): string | undefined {
    return this.store.load(this.serverId).redirectUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "ChatRoom",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string {
    if (!this.flowState)
      throw new Error("MCP OAuth login must be initiated from ChatRoom");
    return this.flowState;
  }
  clientInformation() {
    return this.store.load(this.serverId).client;
  }
  saveClientInformation(client: StoredOAuthClientInformation): void {
    this.store.patch(this.serverId, { client });
  }
  tokens() {
    return this.store.load(this.serverId).tokens;
  }
  saveTokens(tokens: StoredOAuthTokens): void {
    this.store.patch(this.serverId, { tokens });
  }
  redirectToAuthorization(url: URL): void {
    if (!this.flowState)
      throw new Error("MCP server requires browser authorization");
    this.authorizationUrl = url.toString();
  }
  saveCodeVerifier(verifier: string): void {
    this.store.patch(this.serverId, { verifier });
  }
  codeVerifier(): string {
    const verifier = this.store.load(this.serverId).verifier;
    if (!verifier)
      throw new Error("MCP OAuth authorization has expired; retry login");
    return verifier;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.store.patch(this.serverId, { discovery });
  }
  discoveryState() {
    return this.store.load(this.serverId).discovery;
  }
  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    const previous = this.store.load(this.serverId);
    this.store.patch(this.serverId, {
      client:
        scope === "all" || scope === "client" ? undefined : previous.client,
      tokens:
        scope === "all" || scope === "tokens" ? undefined : previous.tokens,
      verifier:
        scope === "all" || scope === "verifier" ? undefined : previous.verifier,
      discovery:
        scope === "all" || scope === "discovery"
          ? undefined
          : previous.discovery,
    });
  }
}
