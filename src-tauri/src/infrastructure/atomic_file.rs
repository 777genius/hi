//! Crash-safe replacement for local settings, auth and companion-bridge JSON.
//! Never remove or truncate the original before a synced replacement is ready.
use std::path::Path;

use anyhow::{anyhow, Result};
use tokio::io::AsyncWriteExt;

pub(crate) async fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("Invalid config path"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Invalid config filename"))?;
    let tmp = parent.join(format!("{}.tmp.{}", name, uuid::Uuid::new_v4()));

    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .await?;

        // Temp files never contain readable secrets before their permissions
        // are restricted. This also secures the final file after rename.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(
                &tmp,
                std::fs::Permissions::from_mode(0o600),
            ).await?;
        }

        file.write_all(contents.as_bytes()).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, path).await?;
        Ok::<(), std::io::Error>(())
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("hackinterview-atomic-file-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn replacement_keeps_only_the_new_complete_file() {
        let root = test_root();
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("settings.json");
        tokio::fs::write(&path, "old").await.unwrap();

        write_atomic(&path, "new").await.unwrap();

        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "new");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                tokio::fs::metadata(&path).await.unwrap().permissions().mode() & 0o777,
                0o600,
            );
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_replacement_keeps_old_target_and_cleans_temp_file() {
        let root = test_root();
        let path = root.join("settings.json");
        tokio::fs::create_dir_all(&path).await.unwrap();

        assert!(write_atomic(&path, "new").await.is_err());
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_writes_never_mix_partial_json() {
        let root = test_root();
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("settings.json");
        let values = (0..8)
            .map(|i| serde_json::json!({"generation": i}).to_string())
            .collect::<Vec<_>>();
        let results = futures_util::future::join_all(
            values.iter().map(|value| write_atomic(&path, value))
        ).await;
        for result in results {
            result.unwrap();
        }

        let final_contents = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(values.contains(&final_contents));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
