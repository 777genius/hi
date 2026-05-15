import { describe, expect, it } from 'vitest';
import {
  companionInstallHint,
  createCompanionRequestId,
  detectCompanionInstallPlatform,
  isCompanionStandalone,
  validateCompanionManifest,
} from './pwa';

describe('isCompanionStandalone', () => {
  it('detects standalone display mode', () => {
    expect(isCompanionStandalone({
      matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' }),
    })).toBe(true);
  });

  it('detects iOS navigator standalone mode', () => {
    expect(isCompanionStandalone({
      navigator: { standalone: true },
    })).toBe(true);
  });

  it('returns false for a normal browser tab', () => {
    expect(isCompanionStandalone({
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: false },
    })).toBe(false);
  });
});

describe('detectCompanionInstallPlatform', () => {
  it('detects iOS devices and iPad desktop user agent mode', () => {
    expect(detectCompanionInstallPlatform({ userAgent: 'Mozilla iPhone' })).toBe('ios');
    expect(detectCompanionInstallPlatform({
      userAgent: 'Mozilla Macintosh',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBe('ios');
  });

  it('detects Android devices', () => {
    expect(detectCompanionInstallPlatform({ userAgent: 'Mozilla Android Chrome' })).toBe('android');
  });
});

describe('companionInstallHint', () => {
  it('returns platform-specific install copy', () => {
    expect(companionInstallHint('ios')).toContain('Add to Home Screen');
    expect(companionInstallHint('android')).toContain('Add to Home screen');
  });
});

describe('createCompanionRequestId', () => {
  it('uses crypto randomUUID when available', () => {
    expect(createCompanionRequestId({ randomUUID: () => 'stable-id' })).toBe('stable-id');
  });

  it('falls back to a stable compact id shape', () => {
    expect(createCompanionRequestId({}, () => 123456, () => 0.5)).toBe('2n9c-i');
  });
});

describe('validateCompanionManifest', () => {
  it('accepts the local companion manifest shape', () => {
    expect(validateCompanionManifest({
      name: 'HackInterview Companion',
      short_name: 'Companion',
      start_url: '/c/token',
      display: 'standalone',
      icons: [{ src: '/companion-icon-512.png', sizes: '512x512', type: 'image/png' }],
    })).toEqual({ ok: true, problems: [] });
  });

  it('reports missing install-critical fields', () => {
    const result = validateCompanionManifest({
      start_url: '/companion.html',
      display: 'browser',
      icons: [],
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain('manifest без name/short_name');
    expect(result.problems).toContain('manifest start_url не ведёт на companion token URL');
    expect(result.problems).toContain('manifest не включает standalone display');
    expect(result.problems).toContain('manifest без 512x512 icon');
  });
});
