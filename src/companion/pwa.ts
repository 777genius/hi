export type CompanionPwaInstallPlatform = 'ios' | 'android' | 'desktop' | 'unknown';

type MediaQueryListLike = {
  matches: boolean;
};

type NavigatorLike = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
};

type WindowLike = {
  matchMedia?: (query: string) => MediaQueryListLike;
  navigator?: NavigatorLike;
};

export type CompanionManifestValidation = {
  ok: boolean;
  problems: string[];
};

type CryptoLike = {
  randomUUID?: () => string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringProp(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isCompanionStandalone(windowLike: WindowLike | null | undefined): boolean {
  const standaloneMatch = windowLike?.matchMedia?.('(display-mode: standalone)').matches === true;
  const fullscreenMatch = windowLike?.matchMedia?.('(display-mode: fullscreen)').matches === true;
  const iosStandalone = windowLike?.navigator?.standalone === true;
  return standaloneMatch || fullscreenMatch || iosStandalone;
}

export function detectCompanionInstallPlatform(
  navigatorLike: NavigatorLike | null | undefined,
): CompanionPwaInstallPlatform {
  const userAgent = String(navigatorLike?.userAgent ?? '').toLowerCase();
  const platform = String(navigatorLike?.platform ?? '').toLowerCase();
  const maxTouchPoints = Number(navigatorLike?.maxTouchPoints ?? 0);

  if (/iphone|ipad|ipod/.test(userAgent) || (platform === 'macintel' && maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/android/.test(userAgent)) {
    return 'android';
  }
  if (userAgent || platform) {
    return 'desktop';
  }
  return 'unknown';
}

export function companionInstallHint(platform: CompanionPwaInstallPlatform): string {
  switch (platform) {
    case 'ios':
      return 'Открой Share и Add to Home Screen, затем запускай Companion с иконки.';
    case 'android':
      return 'Открой меню браузера и выбери Install app или Add to Home screen.';
    case 'desktop':
      return 'Открой меню браузера и установи Companion как приложение.';
    default:
      return 'Добавь Companion на главный экран, чтобы открыть без браузерного хедера.';
  }
}

export function createCompanionRequestId(
  cryptoLike: CryptoLike | undefined = typeof crypto === 'undefined' ? undefined : crypto,
  now: () => number = () => Date.now(),
  random: () => number = () => Math.random(),
): string {
  if (typeof cryptoLike?.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `${now().toString(36)}-${random().toString(36).slice(2, 12)}`;
}

export function validateCompanionManifest(manifest: unknown): CompanionManifestValidation {
  const problems: string[] = [];
  const value = asObject(manifest);

  if (!value) {
    return { ok: false, problems: ['manifest не является JSON объектом'] };
  }

  const name = stringProp(value.name);
  const shortName = stringProp(value.short_name);
  if (!name && !shortName) {
    problems.push('manifest без name/short_name');
  }

  const startUrl = stringProp(value.start_url);
  if (!startUrl.startsWith('/c/')) {
    problems.push('manifest start_url не ведёт на companion token URL');
  }

  const display = stringProp(value.display);
  const displayOverride = Array.isArray(value.display_override)
    ? value.display_override.map(stringProp)
    : [];
  if (display !== 'standalone' && display !== 'fullscreen' && !displayOverride.includes('standalone')) {
    problems.push('manifest не включает standalone display');
  }

  const icons = Array.isArray(value.icons) ? value.icons : [];
  const hasLargeIcon = icons.some((icon) => {
    const iconObject = asObject(icon);
    if (!iconObject) return false;
    return stringProp(iconObject.src).length > 0 && /\b(512x512|1024x1024)\b/.test(stringProp(iconObject.sizes));
  });
  if (!hasLargeIcon) {
    problems.push('manifest без 512x512 icon');
  }

  return { ok: problems.length === 0, problems };
}
