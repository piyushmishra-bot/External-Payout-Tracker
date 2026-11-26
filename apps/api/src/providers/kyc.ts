import type { UserProfileProvider } from './types';

/**
 * Reads the user's KYC PAN from BondScanner's user/KYC service.
 * The PAN is used only in memory to compare with the PAN on an uploaded statement; it is never stored.
 * TODO(BondScanner): confirm the endpoint and response shape with the user-service team.
 */
export class HttpUserProfile implements UserProfileProvider {
  private cache = new Map<string, { pan?: string; at: number }>();
  constructor(
    private readonly urlTemplate: string,
    private readonly token: string,
    private readonly timeoutMs = 3000,
  ) {}

  async kycPan(userId: string): Promise<string | undefined> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.pan;
    try {
      const res = await fetch(this.urlTemplate.replace('{userId}', encodeURIComponent(userId)), {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { pan?: string };
      const pan = body.pan?.toUpperCase().trim() || undefined;
      this.cache.set(userId, { pan, at: Date.now() });
      return pan;
    } catch {
      // KYC service down: fall back to asking the user "Mine / A family member's" (never block the upload).
      return undefined;
    }
  }
}
