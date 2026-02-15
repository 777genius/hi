import { useApiClient } from "~/api";
import { LanguagesRepository } from "~/api/repositories";
import type { LanguageInfo } from "~/api/types";

/**
 * Composable для получения списка поддерживаемых языков nova-3.
 * Загружает данные на клиенте при монтировании компонента.
 */
export function useSupportedLanguages() {
  const languages = ref<LanguageInfo[]>([]);
  const loading = ref(true);
  const error = ref<string | null>(null);

  // Инициализация в setup-контексте (useRuntimeConfig доступен)
  const client = useApiClient();
  const repo = new LanguagesRepository(client);

  const fetchLanguages = async () => {
    loading.value = true;
    error.value = null;

    try {
      const data = await repo.getNova3Languages();

      // Убираем дубликаты по country_code (оставляем первый — обычно базовый вариант)
      const seen = new Set<string>();
      languages.value = data.languages.filter((lang) => {
        if (seen.has(lang.country_code)) return false;
        seen.add(lang.country_code);
        return true;
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Не удалось загрузить языки";
      error.value = msg;
      console.warn("[useSupportedLanguages]", msg);
    } finally {
      loading.value = false;
    }
  };

  if (import.meta.client) {
    onMounted(fetchLanguages);
  }

  return { languages, loading, error };
}
