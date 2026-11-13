//! Тестовый режим "интервьюер": по кнопке озвучивает следующий вопрос через системный вывод,
//! чтобы приложение записало его как речь собеседника (system audio).
//!
//! Включается переменной окружения `INTERVIEW_TEST_MODE=1`. В обычном запуске не активен.

use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const TEST_MODE_ENV: &str = "INTERVIEW_TEST_MODE";
const DEFAULT_VOICE: &str = "Lesya";
const DEFAULT_RATE_WPM: &str = "165";

/// Вопросы собеседования на позицию Full-Stack Software Engineer (AI-Native):
/// Rails / Node.js+TypeScript / Python, PostgreSQL, API design, AWS, agentic AI tools, CI/CD.
/// Идут от разминки к сложным системным вопросам.
const QUESTIONS: &[&str] = &[
    "Привіт! Давайте почнемо. Розкажіть коротко про свій досвід: які backend-системи ви будували в production і на якому стеку?",
    "Ви працювали з Ruby on Rails, Node.js з TypeScript або Python. Чому ви обрали б кожен з них для нового сервісу, і в чому їхні головні trade-offs?",
    "Як ви проєктуєте схему в PostgreSQL для складного бізнес-домену, який постійно змінюється? Як ви працюєте з міграціями без downtime?",
    "Поясніть різницю між B-tree, GIN та partial індексами. Коли запит у PostgreSQL перестає використовувати індекс, і як ви це діагностуєте через EXPLAIN ANALYZE?",
    "Що таке проблема N+1 запитів? Як ви її знаходите і виправляєте, наприклад в Rails з ActiveRecord або в Node.js з ORM?",
    "Розкажіть про транзакції та рівні ізоляції в PostgreSQL. Який рівень ви використовуєте за замовчуванням, і що таке race condition при паралельному оновленні одного рядка?",
    "Як ви проєктуєте REST API, щоб він був стабільним контрактом для інших команд? Як ви робите versioning, pagination, idempotency та error handling?",
    "У нас є system-to-system інтеграції. Як ви зробите надійну інтеграцію з зовнішнім API, яке іноді падає: retries, backoff, timeouts, dead letter queue, idempotency keys?",
    "Порівняйте REST, GraphQL та gRPC. Для якого сценарію ви обрали б кожен, і як ви описуєте контракт, наприклад через OpenAPI?",
    "Як ви моделюєте event-driven взаємодію між сервісами? Коли ви обираєте черги, наприклад SQS, а коли Kafka чи EventBridge, і як гарантуєте at-least-once доставку без дублікатів?",
    "Розкажіть, як ви працювали з AWS. Які сервіси ви використовували для backend: ECS, Lambda, RDS, S3, SQS, і як ви налаштовували IAM за принципом least privilege?",
    "Як ви організуєте CI/CD для моноліту та кількох сервісів? Які етапи в пайплайні: тести, лінтери, security scan, canary чи blue-green deployment, rollback?",
    "На фронтенді ми використовуємо Vue з TypeScript. Як ви структуруєте state management та типізуєте відповіді API, щоб frontend і backend не роз'їжджалися?",
    "Ви щодня користуєтеся agentic AI coding tools. Як саме ви їх використовуєте у workflow, і де ви не довіряєте згенерованому коду та перевіряєте його вручну?",
    "Як масштабувати AI-native розробку на всю команду? Які shared workflows, prompts, правила для агентів та інтеграцію з CI ви б впровадили, і як міряти їхню користь?",
    "Ми будуємо LLM features на enterprise-платформах, наприклад AWS Bedrock. Як ви проєктуєте таку feature: prompt, guardrails, evaluation, observability, витрати та latency?",
    "Як ви тестуєте LLM-функціональність, яка недетермінована? Що таке evals, regression набори та як ви ловите деградацію якості після зміни моделі чи prompt?",
    "У нас є аналітичні дані в Snowflake та транзакційні в PostgreSQL. Як би ви організували потік даних між ними, і як вирішуєте проблему узгодженості та schema evolution?",
    "Опишіть складний production-інцидент, який ви розслідували. Як ви знаходили причину, які метрики, логи та traces допомогли, і що змінили, щоб це не повторилося?",
    "Останнє питання. Уявіть, що product-команда просить швидку фічу, яка псує domain model. Як ви ведете переговори, шукаєте компроміс та фіксуєте технічний борг?",
];

static NEXT_INDEX: AtomicUsize = AtomicUsize::new(0);
static SPEAKING: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestInterviewQuestion {
    /// Номер озвученного вопроса, начиная с 1.
    pub number: usize,
    pub total: usize,
    pub text: String,
    /// true, если это последний вопрос (следующий нажатие начнёт цикл заново).
    pub is_last: bool,
}

pub fn is_enabled() -> bool {
    std::env::var(TEST_MODE_ENV).ok().as_deref() == Some("1")
}

pub fn total_questions() -> usize {
    QUESTIONS.len()
}

/// Озвучивает следующий вопрос и возвращает его. После последнего вопроса цикл начинается заново.
pub fn speak_next_question() -> Result<TestInterviewQuestion, String> {
    if !is_enabled() {
        return Err(format!("Test interviewer is disabled: set {TEST_MODE_ENV}=1"));
    }

    let index = NEXT_INDEX.fetch_add(1, Ordering::Relaxed) % QUESTIONS.len();
    let text = QUESTIONS[index];
    speak(text)?;

    Ok(TestInterviewQuestion {
        number: index + 1,
        total: QUESTIONS.len(),
        text: text.to_string(),
        is_last: index + 1 == QUESTIONS.len(),
    })
}

/// Проигрывает сырой PCM (s16le, 48 кГц, стерео) в указанное устройство вывода из ПРОЦЕССА ПРИЛОЖЕНИЯ.
/// Звук собственного процесса ScreenCaptureKit исключает (`excludes_current_process_audio`),
/// поэтому реплика кандидата, играемая в BlackHole, попадает только в микрофонный канал
/// и не дублируется в системном. Возвращает длительность в секундах.
#[cfg(target_os = "macos")]
pub fn play_pcm_to_device(path: &str, device_name: &str) -> Result<f64, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::Arc;
    use std::time::Duration;

    if !is_enabled() {
        return Err(format!("Test interviewer is disabled: set {TEST_MODE_ENV}=1"));
    }

    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .collect();
    if samples.is_empty() {
        return Err("PCM file is empty".to_string());
    }
    let seconds = samples.len() as f64 / (48_000.0 * 2.0);

    let host = cpal::default_host();
    let needle = device_name.to_lowercase();
    let device = host
        .output_devices()
        .map_err(|e| format!("Failed to list output devices: {e}"))?
        .find(|d| d.name().map(|n| n.to_lowercase().contains(&needle)).unwrap_or(false))
        .ok_or_else(|| format!("Output device \"{device_name}\" not found"))?;

    let config = device
        .supported_output_configs()
        .map_err(|e| format!("Failed to read output configs: {e}"))?
        .find(|c| {
            c.channels() == 2
                && c.sample_format() == cpal::SampleFormat::F32
                && c.min_sample_rate().0 <= 48_000
                && c.max_sample_rate().0 >= 48_000
        })
        .ok_or_else(|| "Device has no stereo f32 48 kHz output config".to_string())?
        .with_sample_rate(cpal::SampleRate(48_000))
        .config();

    let data = Arc::new(samples);
    let position = Arc::new(AtomicUsize::new(0));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let data_cb = data.clone();
    let position_cb = position.clone();

    let stream = device
        .build_output_stream(
            &config,
            move |out: &mut [f32], _| {
                let start = position_cb.load(Ordering::Relaxed);
                for (i, slot) in out.iter_mut().enumerate() {
                    *slot = data_cb.get(start + i).copied().unwrap_or(0.0);
                }
                let next = start + out.len();
                position_cb.store(next, Ordering::Relaxed);
                if next >= data_cb.len() {
                    let _ = done_tx.send(());
                }
            },
            |err| log::warn!("Test interviewer output stream error: {err}"),
            None,
        )
        .map_err(|e| format!("Failed to open output stream: {e}"))?;
    stream.play().map_err(|e| format!("Failed to start output stream: {e}"))?;

    done_rx
        .recv_timeout(Duration::from_secs_f64(seconds + 10.0))
        .map_err(|_| "Playback did not finish in time".to_string())?;
    std::thread::sleep(Duration::from_millis(400));
    drop(stream);
    Ok(seconds)
}

#[cfg(not(target_os = "macos"))]
pub fn play_pcm_to_device(_path: &str, _device_name: &str) -> Result<f64, String> {
    Err("Test interviewer is supported only on macOS".to_string())
}

pub fn reset() {
    NEXT_INDEX.store(0, Ordering::Relaxed);
    stop_speaking();
}

fn stop_speaking() {
    if let Ok(mut slot) = SPEAKING.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(target_os = "macos")]
fn speak(text: &str) -> Result<(), String> {
    let voice = std::env::var("INTERVIEW_TEST_VOICE").unwrap_or_else(|_| DEFAULT_VOICE.to_string());
    let rate = std::env::var("INTERVIEW_TEST_RATE").unwrap_or_else(|_| DEFAULT_RATE_WPM.to_string());

    // Предыдущая реплика обрывается, чтобы вопросы не накладывались друг на друга.
    stop_speaking();

    let child = Command::new("/usr/bin/say")
        .args(["-v", &voice, "-r", &rate, "--", text])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start `say`: {e}"))?;

    if let Ok(mut slot) = SPEAKING.lock() {
        *slot = Some(child);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn speak(_text: &str) -> Result<(), String> {
    Err("Test interviewer is supported only on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_list_is_not_empty_and_has_no_blank_entries() {
        assert!(!QUESTIONS.is_empty());
        assert!(QUESTIONS.iter().all(|q| !q.trim().is_empty()));
    }
}
