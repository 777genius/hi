import { describe, expect, it } from 'vitest';
import {
  classifyCompanionFailureMessage,
  connectionTextForCompanionFailure,
  normalizeCompanionRequestError,
  shouldRecoverCompanionConnection,
  toneForCompanionFailure,
} from './connectionErrors';

describe('normalizeCompanionRequestError', () => {
  it('prefers hidden-page message for aborted requests even if browser throws TypeError', () => {
    const error = normalizeCompanionRequestError(new TypeError('Failed to fetch'), {
      aborted: true,
      offline: false,
      hidden: true,
    });

    expect(error.message).toBe('Страница была скрыта, обновлю состояние после возврата');
  });

  it('returns offline message for aborted requests when navigator is offline', () => {
    const error = normalizeCompanionRequestError(new Error('AbortError'), {
      aborted: true,
      offline: true,
      hidden: false,
    });

    expect(error.message).toBe('Телефон офлайн');
  });

  it('maps network fetch failures to a stable user-facing message', () => {
    const error = normalizeCompanionRequestError(new TypeError('NetworkError when attempting to fetch resource.'), {
      aborted: false,
      offline: false,
      hidden: false,
    });

    expect(error.message).toContain('Не удалось подключиться к компьютеру');
  });
});

describe('companion failure classification', () => {
  it('marks temporary network failures as recoverable warnings', () => {
    const kind = classifyCompanionFailureMessage('Компьютер не ответил вовремя');

    expect(kind).toBe('timeout');
    expect(toneForCompanionFailure(kind)).toBe('warn');
    expect(shouldRecoverCompanionConnection(kind)).toBe(true);
    expect(connectionTextForCompanionFailure(kind, 'Пытаюсь восстановить связь с компьютером...'))
      .toBe('Пытаюсь восстановить связь с компьютером...');
  });

  it('keeps classifying legacy Mac wording during transition', () => {
    expect(classifyCompanionFailureMessage('Mac не ответил вовремя')).toBe('timeout');
    expect(classifyCompanionFailureMessage('Не удалось подключиться к Mac')).toBe('network');
  });

  it('marks expired token as non-recoverable disconnect', () => {
    const kind = classifyCompanionFailureMessage('Ссылка устарела или companion перезапустился. Открой QR из окна приложения заново.');

    expect(kind).toBe('expired');
    expect(toneForCompanionFailure(kind)).toBe('error');
    expect(shouldRecoverCompanionConnection(kind)).toBe(false);
    expect(connectionTextForCompanionFailure(kind, 'fallback'))
      .toBe('Ссылка устарела. Открой QR из окна приложения заново.');
  });
});
