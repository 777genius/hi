use std::env;
use std::fs;
use std::path::Path;

fn main() {
    // Сначала запускаем стандартный билд Tauri
    tauri_build::build();

    // macOS: ScreenCaptureKit (Swift) требует Swift runtime dylibs.
    // В dev-режиме (tauri dev) приложение запускается как бинарник из target/,
    // поэтому добавляем rpath на директории Swift stdlib из Xcode/CommandLineTools.
    #[cfg(target_os = "macos")]
    {
        fn add_rpath_if_exists(p: &str) {
            if Path::new(p).exists() {
                println!("cargo:rustc-link-arg=-Wl,-rpath,{}", p);
            }
        }

        // Prefer system Swift runtime (dyld shared cache).
        add_rpath_if_exists("/usr/lib/swift");

        // Legacy locations (older toolchains).
        add_rpath_if_exists("/Library/Developer/CommandLineTools/usr/lib/swift/macosx");
        add_rpath_if_exists(
            "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx",
        );

        // Newer Xcode/CLT locations: swift runtime dylibs live under swift-*/macosx.
        fn add_swift_versioned_rpaths(toolchain_root: &str) {
            let lib_root = format!("{}/usr/lib", toolchain_root.trim_end_matches('/'));
            let Ok(entries) = fs::read_dir(&lib_root) else {
                return;
            };

            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                if !ft.is_dir() {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("swift-") {
                    continue;
                }

                let candidate = format!("{}/{}/macosx", lib_root, name);
                let dylib = format!("{}/libswift_Concurrency.dylib", candidate);
                if Path::new(&dylib).exists() {
                    add_rpath_if_exists(&candidate);
                }
            }
        }

        add_swift_versioned_rpaths("/Library/Developer/CommandLineTools");
        add_swift_versioned_rpaths("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain");
    }

    // Загружаем .env файл если он существует
    if let Err(e) = dotenv::dotenv() {
        println!("cargo:warning=No .env file found: {}", e);
    }

    // Читаем API ключи из переменных окружения
    let deepgram_key = env::var("DEEPGRAM_API_KEY")
        .unwrap_or_else(|_| {
            println!("cargo:warning=DEEPGRAM_API_KEY not found in environment");
            String::new()
        });

    let assemblyai_key = env::var("ASSEMBLYAI_API_KEY")
        .unwrap_or_else(|_| {
            println!("cargo:warning=ASSEMBLYAI_API_KEY not found in environment");
            String::new()
        });

    // Генерируем Rust код с встроенными ключами
    let embedded_keys_code = format!(
        r#"// Этот файл сгенерирован автоматически build.rs
// НЕ РЕДАКТИРУЙТЕ ВРУЧНУЮ

/// Встроенный API ключ для Deepgram
pub const EMBEDDED_DEEPGRAM_KEY: &str = "{}";

/// Встроенный API ключ для AssemblyAI
pub const EMBEDDED_ASSEMBLYAI_KEY: &str = "{}";

/// Проверяет есть ли встроенный ключ для Deepgram
pub fn has_embedded_deepgram_key() -> bool {{
    !EMBEDDED_DEEPGRAM_KEY.is_empty()
}}

/// Проверяет есть ли встроенный ключ для AssemblyAI
pub fn has_embedded_assemblyai_key() -> bool {{
    !EMBEDDED_ASSEMBLYAI_KEY.is_empty()
}}
"#,
        deepgram_key, assemblyai_key
    );

    // Путь к генерируемому файлу
    let out_dir = Path::new("src/infrastructure");
    let dest_path = out_dir.join("embedded_keys.rs");

    // Записываем сгенерированный код
    fs::write(&dest_path, embedded_keys_code)
        .expect("Failed to write embedded_keys.rs");

    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-env-changed=DEEPGRAM_API_KEY");
    println!("cargo:rerun-if-env-changed=ASSEMBLYAI_API_KEY");

    println!("✅ Generated embedded_keys.rs with API keys");
}
