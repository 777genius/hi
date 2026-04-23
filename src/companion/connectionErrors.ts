export type CompanionFailureKind =
  | 'hidden'
  | 'offline'
  | 'network'
  | 'timeout'
  | 'expired'
  | 'other';

type NormalizeFailureOptions = {
  aborted: boolean;
  offline: boolean;
  hidden: boolean;
};

const NETWORK_ERROR_PATTERN = /failed to fetch|networkerror/i;

export function normalizeCompanionRequestError(
  error: unknown,
  options: NormalizeFailureOptions
): Error {
  if (options.aborted) {
    if (options.offline) {
      return new Error('Телефон офлайн');
    }
    if (options.hidden) {
      return new Error('Страница была скрыта, обновлю состояние после возврата');
    }
    return new Error('Mac не ответил вовремя');
  }

  if (
    error instanceof TypeError
    || (error instanceof Error && NETWORK_ERROR_PATTERN.test(error.message))
  ) {
    return new Error('Не удалось подключиться к Mac. Проверь, что телефон и Mac в одной сети, а приложение запущено.');
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

export function classifyCompanionFailureMessage(message: string): CompanionFailureKind {
  if (message.includes('Страница была скрыта')) {
    return 'hidden';
  }
  if (message.includes('Ссылка устарела')) {
    return 'expired';
  }
  if (message.includes('Телефон офлайн')) {
    return 'offline';
  }
  if (message.includes('Не удалось подключиться к Mac')) {
    return 'network';
  }
  if (message.includes('Mac не ответил вовремя')) {
    return 'timeout';
  }
  return 'other';
}

export function toneForCompanionFailure(kind: CompanionFailureKind): 'warn' | 'error' {
  switch (kind) {
    case 'hidden':
    case 'offline':
    case 'network':
    case 'timeout':
      return 'warn';
    case 'expired':
    case 'other':
    default:
      return 'error';
  }
}

export function connectionTextForCompanionFailure(
  kind: CompanionFailureKind,
  fallbackText: string
): string {
  switch (kind) {
    case 'expired':
      return 'Ссылка устарела. Открой QR из окна на Mac заново.';
    case 'offline':
      return 'Телефон офлайн. Жду восстановления сети...';
    case 'network':
    case 'timeout':
    case 'other':
    case 'hidden':
    default:
      return fallbackText;
  }
}

export function shouldRecoverCompanionConnection(kind: CompanionFailureKind): boolean {
  return kind === 'offline' || kind === 'network' || kind === 'timeout';
}
