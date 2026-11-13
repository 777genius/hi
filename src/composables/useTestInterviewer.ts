import { onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { isTauriAvailable } from '@/utils/tauri';

type TestInterviewQuestion = {
  number: number;
  total: number;
  text: string;
  isLast: boolean;
};

/**
 * Тестовый режим интервьюера (запуск с INTERVIEW_TEST_MODE=1): кнопка озвучивает
 * следующий вопрос через системный вывод, как будто его задаёт собеседник.
 */
export function useTestInterviewer() {
  const enabled = ref(false);
  const total = ref(0);
  const lastQuestion = ref<TestInterviewQuestion | null>(null);
  const busy = ref(false);

  onMounted(async () => {
    if (!isTauriAvailable()) return;
    try {
      const [isEnabled, count] = await invoke<[boolean, number]>('get_test_interviewer_state');
      enabled.value = isEnabled;
      total.value = count;
    } catch {
      enabled.value = false;
    }
  });

  async function askNext(): Promise<void> {
    if (!enabled.value || busy.value) return;
    busy.value = true;
    try {
      lastQuestion.value = await invoke<TestInterviewQuestion>('test_interviewer_next_question');
    } catch (err) {
      console.error('test interviewer failed', err);
    } finally {
      busy.value = false;
    }
  }

  async function reset(): Promise<void> {
    if (!enabled.value) return;
    try {
      await invoke('test_interviewer_reset');
      lastQuestion.value = null;
    } catch (err) {
      console.error('test interviewer reset failed', err);
    }
  }

  return { enabled, total, lastQuestion, busy, askNext, reset };
}
