//! Explicit post-transcription corrections for offline models without vocabulary support.
//! One line per term: `Canonical term = heard variant | another variant`.
use std::path::PathBuf;

const MAX_RULES: usize = 100;
const MAX_ALIASES_PER_RULE: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Rule {
    canonical: String,
    alias: String,
}

#[derive(Clone, Debug, Default)]
pub struct LocalGlossary {
    rules: Vec<Rule>,
    /// Canonical terms in file order, used as the Whisper decoding vocabulary.
    terms: Vec<String>,
}

impl LocalGlossary {
    pub fn load() -> Self {
        let Some(path) = Self::path() else {
            return Self::default();
        };
        match std::fs::read_to_string(&path) {
            Ok(source) => Self::parse(&source),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                log::warn!("Could not read local STT glossary at {}: {error}", path.display());
                Self::default()
            }
        }
    }

    pub fn path() -> Option<PathBuf> {
        dirs::config_dir().map(|root| root.join("HackInterview/parakeet_glossary.txt"))
    }

    fn parse(source: &str) -> Self {
        let mut rules = Vec::new();
        let mut terms: Vec<String> = Vec::new();
        for line in source.lines().take(MAX_RULES) {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (canonical, aliases) = line.split_once('=').unwrap_or((line, ""));
            let canonical = canonical.trim();
            if canonical.is_empty() || canonical.chars().count() > 80 {
                continue;
            }
            if !terms.iter().any(|term| term == canonical) {
                terms.push(canonical.to_string());
            }
            for alias in std::iter::once(canonical)
                .chain(aliases.split('|').map(str::trim))
                .take(MAX_ALIASES_PER_RULE + 1)
            {
                if alias.is_empty() || alias.chars().count() > 80 {
                    continue;
                }
                rules.push(Rule {
                    canonical: canonical.to_string(),
                    alias: alias.to_string(),
                });
            }
        }
        // Prefer the longest phrase when aliases overlap.
        rules.sort_by_key(|rule| std::cmp::Reverse(rule.alias.chars().count()));
        Self { rules, terms }
    }

    /// Canonical terms (file order) that fit into `max_chars`, for models that
    /// accept a decoding vocabulary instead of relying on post-correction only.
    pub fn vocabulary(&self, max_chars: usize) -> Vec<String> {
        let mut used = 0;
        let mut selected = Vec::new();
        for term in &self.terms {
            used += term.chars().count() + 2; // separator the decoder adds
            if used > max_chars {
                break;
            }
            selected.push(term.clone());
        }
        selected
    }

    pub fn correct(&self, text: &str) -> String {
        if self.rules.is_empty() {
            return text.to_string();
        }
        let mut result = String::with_capacity(text.len());
        let mut cursor = 0;
        while cursor < text.len() {
            if let Some((rule, end)) = self.rules.iter().find_map(|rule| {
                Self::match_alias(text, cursor, &rule.alias).map(|end| (rule, end))
            }) {
                result.push_str(&rule.canonical);
                cursor = end;
            } else {
                let ch = text[cursor..].chars().next().expect("valid character boundary");
                result.push(ch);
                cursor += ch.len_utf8();
            }
        }
        result
    }

    fn match_alias(text: &str, start: usize, alias: &str) -> Option<usize> {
        let before = text[..start].chars().next_back();
        if before.is_some_and(char::is_alphanumeric) {
            return None;
        }
        let mut end = start;
        let mut remaining = text[start..].chars();
        for expected in alias.chars() {
            let actual = remaining.next()?;
            if actual.to_lowercase().to_string() != expected.to_lowercase().to_string() {
                return None;
            }
            end += actual.len_utf8();
        }
        if text[end..].chars().next().is_some_and(char::is_alphanumeric) {
            return None;
        }
        Some(end)
    }
}

#[cfg(test)]
mod tests {
    use super::LocalGlossary;

    #[test]
    fn corrects_explicit_aliases_across_three_languages() {
        let glossary = LocalGlossary::parse(
            "Clean Architecture = клин архитектура | clean архитектура\nSOLID = солид\nDRY = драй",
        );
        assert_eq!(
            glossary.correct("Про клин архитектура, солид и драй."),
            "Про Clean Architecture, SOLID и DRY."
        );
        assert_eq!(
            glossary.correct("clean architecture and solid, dry."),
            "Clean Architecture and SOLID, DRY."
        );
    }

    #[test]
    fn vocabulary_lists_canonical_terms_once_within_budget() {
        let glossary = LocalGlossary::parse(
            "Clean Architecture = клин архитектура\nSOLID = солид\nDRY = драй\nSOLID = солід",
        );
        assert_eq!(
            glossary.vocabulary(1000),
            vec!["Clean Architecture", "SOLID", "DRY"]
        );
        // "Clean Architecture" (18) + 2 fits in 20; the next term does not.
        assert_eq!(glossary.vocabulary(20), vec!["Clean Architecture"]);
        assert!(LocalGlossary::default().vocabulary(100).is_empty());
    }

    #[test]
    fn keeps_unlisted_words_and_word_boundaries() {
        let glossary = LocalGlossary::parse("DRY = драй");
        assert_eq!(glossary.correct("драйвер и драй"), "драйвер и DRY");
        assert_eq!(glossary.correct("unknown phrase"), "unknown phrase");
    }
}
