// The people and their groups, from OpenAsy Identity's directory (GET /api/v1/people), read with an API token that has
// the viewer role there, as Passwords and Awareness do (ADR 0071). With it, a policy knows everyone who should read it,
// also those who never opened the wiki; without it, the wiki knows the people who signed in.

export interface Person {
  id: string;
  email: string;
  name: string;
  status: "invited" | "active" | "disabled";
  /** Group names, as the file uses them. */
  groups: string[];
}

export class IdentityError extends Error {}

export interface IdentityOptions {
  /** Identity's address, such as https://id.example.com. */
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createIdentity({ url, token, fetch: f = fetch, timeoutMs = 15_000 }: IdentityOptions) {
  const base = url.replace(/\/$/, "");
  return {
    url: base,
    async people(): Promise<Person[]> {
      let res: Response;
      try {
        res = await f(`${base}/api/v1/people`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new IdentityError(`Identity at ${base} cannot be reached: ${(err as Error).message}`);
      }
      if (res.status === 401 || res.status === 403) throw new IdentityError("Identity refused the token; it needs the viewer role (identity.token).");
      if (!res.ok) throw new IdentityError(`Identity answered ${res.status}.`);
      const body = (await res.json()) as { people?: Array<Partial<Person>> };
      return (body.people ?? [])
        .filter((p): p is Person => typeof p.id === "string" && typeof p.email === "string")
        .map((p) => ({
          id: p.id,
          email: p.email.trim().toLowerCase(),
          name: p.name || p.email,
          status: p.status === "disabled" || p.status === "invited" ? p.status : "active",
          groups: Array.isArray(p.groups) ? p.groups.filter((g) => typeof g === "string") : [],
        }));
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;
