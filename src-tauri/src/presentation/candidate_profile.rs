//! Профиль кандидата (резюме, стек, проекты) как часть системного промпта.
//!
//! Файл читается при КАЖДОМ запросе, чтобы правки применялись без рестарта:
//! `<config_dir>/HackInterview/candidate_profile.md` или путь из `INTERVIEW_PROFILE_FILE`.
//! Содержимое личное: в git и в логи не попадает, в лог пишется только размер.

use std::path::PathBuf;

const PROFILE_ENV: &str = "INTERVIEW_PROFILE_FILE";
const PROFILE_FILE_NAME: &str = "HackInterview/candidate_profile.md";
const BEGIN_MARKER: &str = "=== CANDIDATE PROFILE BEGIN ===";
const END_MARKER: &str = "=== CANDIDATE PROFILE END ===";
const WARN_CHARS: usize = 60_000;

fn profile_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(PROFILE_ENV).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    dirs::config_dir().map(|root| root.join(PROFILE_FILE_NAME))
}

/// Вырезает HTML-комментарии `<!-- ... -->` (заметки автора файла не должны попадать в промпт).
/// Незакрытый комментарий отбрасывает остаток текста.
fn strip_html_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start + 4..].find("-->") {
            Some(end) => rest = &rest[start + 4 + end + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Убирает ранее вставленный блок профиля, чтобы повторный вызов обновлял его, а не дублировал.
fn remove_existing_block(system_prompt: &str) -> String {
    let Some(begin) = system_prompt.find(BEGIN_MARKER) else {
        return system_prompt.to_string();
    };
    let after_begin = begin + BEGIN_MARKER.len();
    let block_end = system_prompt[after_begin..]
        .find(END_MARKER)
        .map(|idx| after_begin + idx + END_MARKER.len())
        .unwrap_or(system_prompt.len());
    let mut result = system_prompt[..begin].trim_end().to_string();
    let tail = system_prompt[block_end..].trim();
    if !tail.is_empty() {
        result.push_str("\n\n");
        result.push_str(tail);
    }
    result
}

pub(crate) fn with_candidate_profile_text(system_prompt: String, profile: Option<&str>) -> String {
    let base = remove_existing_block(&system_prompt);
    let cleaned = profile.map(strip_html_comments).unwrap_or_default();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return base;
    }
    format!(
        "{}\n\n{}\nНиже профиль кандидата (это пользователь, от первого лица). Опирайся на него для вопросов про опыт и стек; факты из профиля не противоречь и не выдумывай новых.\n\n{}\n{}",
        base.trim_end(),
        BEGIN_MARKER,
        cleaned,
        END_MARKER
    )
}

/// Дописывает профиль кандидата в КОНЕЦ системного промпта (стабильный префикс лучше для prompt cache).
/// Нет файла или он пуст: промпт возвращается без изменений.
pub fn with_candidate_profile(system_prompt: String) -> String {
    let profile = profile_path().and_then(|path| std::fs::read_to_string(path).ok());
    if let Some(text) = profile.as_deref() {
        let chars = text.chars().count();
        if chars > WARN_CHARS {
            log::warn!("Candidate profile is large: {chars} chars (~{} tokens)", chars / 3);
        } else {
            log::debug!("Candidate profile loaded: {chars} chars (~{} tokens)", chars / 3);
        }
    }
    with_candidate_profile_text(system_prompt, profile.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_blank_profile_keeps_prompt() {
        assert_eq!(with_candidate_profile_text("base".into(), None), "base");
        assert_eq!(with_candidate_profile_text("base".into(), Some("  \n <!-- note --> ")), "base");
    }

    #[test]
    fn html_comments_are_stripped_including_unterminated() {
        assert_eq!(strip_html_comments("a<!-- x -->b<!--y-->c"), "abc");
        assert_eq!(strip_html_comments("keep<!-- never closed"), "keep");
    }

    #[test]
    fn profile_is_idempotent_and_refreshed_in_place() {
        let first = with_candidate_profile_text("base".into(), Some("old fact <!-- ПОДТВЕРДИТЬ -->"));
        assert!(first.contains("old fact") && !first.contains("ПОДТВЕРДИТЬ"));
        let again = with_candidate_profile_text(first.clone(), Some("old fact <!-- ПОДТВЕРДИТЬ -->"));
        assert_eq!(first, again);
        let updated = with_candidate_profile_text(first, Some("new fact"));
        assert!(updated.contains("new fact") && !updated.contains("old fact"));
        assert_eq!(updated.matches(BEGIN_MARKER).count(), 1);
    }
}
