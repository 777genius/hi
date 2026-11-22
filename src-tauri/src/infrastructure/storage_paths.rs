//! OS storage locations in production; private process-owned locations in unit tests.
use std::path::PathBuf;

#[cfg(test)]
pub(crate) fn test_root() -> &'static std::path::Path {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let path = std::env::temp_dir().join(format!("hackinterview-unit-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).expect("create private unit test storage");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).expect("secure unit test storage");
        }
        path
    })
}

pub(crate) fn config_dir() -> Option<PathBuf> {
    #[cfg(test)] { Some(test_root().join("config")) }
    #[cfg(not(test))] { dirs::config_dir() }
}
pub(crate) fn data_dir() -> Option<PathBuf> {
    #[cfg(test)] { Some(test_root().join("data")) }
    #[cfg(not(test))] { dirs::data_dir() }
}
pub(crate) fn home_dir() -> Option<PathBuf> {
    #[cfg(test)] { Some(test_root().join("home")) }
    #[cfg(not(test))] { dirs::home_dir() }
}

/// Environment overrides are supported, but unit tests must not inherit paths
/// to persistent user files. Tests may explicitly use disposable temp files.
pub(crate) fn writable_override(path: PathBuf) -> Option<PathBuf> {
    #[cfg(test)] {
        let temp = std::env::temp_dir();
        if !path.is_absolute() || !path.starts_with(&temp)
            || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
            return None;
        }
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_storage_is_intrinsically_isolated_without_environment_changes() {
        for path in [config_dir(), data_dir(), home_dir()].into_iter().flatten() {
            assert!(path.starts_with(test_root()));
            assert_ne!(Some(path.clone()), dirs::config_dir());
            assert_ne!(Some(path), dirs::home_dir());
        }
        assert!(writable_override(PathBuf::from("/Users/user/Library/Application Support/app.json")).is_none());
        assert!(writable_override(std::env::temp_dir().join("../app.json")).is_none());
        assert!(writable_override(test_root().join("fixture.json")).is_some());
    }
}
