//! Native on-device AI: llama.cpp compiled into the app (via llama-cpp-2).
//!
//! Much faster than the WebAssembly engine because it uses the CPU's SIMD
//! instructions and several threads. Models are plain GGUF files stored in the
//! app's private data folder (`<app data>/models`).

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};

use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use serde::Serialize;

use crate::llm_core::{self, ChatMessage, GenParams, Loaded, GEN_CANCEL};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

// === Paths ===

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Only plain file names ending in .gguf are accepted (no paths).
fn model_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let ok = file.ends_with(".gguf")
        && !file.contains('/')
        && !file.contains('\\')
        && !file.contains("..")
        && !file.is_empty();
    if !ok {
        return Err("Invalid model file name".into());
    }
    Ok(models_dir(app)?.join(file))
}

// === Model files ===

#[derive(Serialize)]
pub struct ModelFile {
    file: String,
    size: u64,
}

#[tauri::command]
pub fn llm_list(app: AppHandle) -> Result<Vec<ModelFile>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(models_dir(&app)?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".gguf") {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ModelFile { file: name, size });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn llm_delete(app: AppHandle, file: String) -> Result<(), String> {
    let path = model_path(&app, &file)?;
    unload_if(&path);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

/// Streams a model from `url` into the models folder, reporting bytes written.
#[tauri::command]
pub async fn llm_download(
    app: AppHandle,
    url: String,
    file: String,
    on_progress: Channel<u64>,
) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only HTTPS downloads are allowed".into());
    }
    let path = model_path(&app, &file)?;
    let part = path.with_extension("gguf.part");
    DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);

    let client = tauri_plugin_http::reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed (HTTP {})", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut written: u64 = 0;
    let mut last_report: u64 = 0;
    loop {
        if DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
            drop(out);
            let _ = fs::remove_file(&part);
            return Err("Download cancelled.".into());
        }
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = out.write_all(&chunk) {
                    drop(out);
                    let _ = fs::remove_file(&part);
                    return Err(if e.raw_os_error() == Some(28) {
                        "Not enough free storage on this device for this model.".into()
                    } else {
                        e.to_string()
                    });
                }
                written += chunk.len() as u64;
                if written - last_report >= 512 * 1024 {
                    last_report = written;
                    let _ = on_progress.send(written);
                }
            }
            Ok(None) => break,
            Err(e) => {
                drop(out);
                let _ = fs::remove_file(&part);
                return Err(format!("Download interrupted: {e}"));
            }
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && written != total {
        let _ = fs::remove_file(&part);
        return Err("Download was incomplete. Please try again.".into());
    }
    fs::rename(&part, &path).map_err(|e| e.to_string())?;
    let _ = on_progress.send(written);
    Ok(())
}

#[tauri::command]
pub fn llm_cancel_download() {
    DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
}

/// Appends raw bytes to a model file (used to move models downloaded by the
/// older WebAssembly engine into native storage without downloading again).
#[tauri::command]
pub fn llm_import_chunk(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let file = request
        .headers()
        .get("x-file")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing file name")?
        .to_string();
    let first = request.headers().get("x-first").is_some();
    let last = request.headers().get("x-last").is_some();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let path = model_path(&app, &file)?;
    let part = path.with_extension("gguf.part");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!first)
        .truncate(first)
        .open(&part)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    if last {
        drop(f);
        fs::rename(&part, &path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// === Inference worker ===
// llama.cpp objects stay on one dedicated thread; commands talk to it through a channel.


enum Job {
    Load {
        path: PathBuf,
        n_ctx: u32,
        n_threads: i32,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Chat {
        messages: Vec<ChatMessage>,
        params: GenParams,
        on_token: Channel<String>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Unload,
}

static WORKER: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();
static LOADED: Mutex<Option<PathBuf>> = Mutex::new(None);

fn worker() -> mpsc::Sender<Job> {
    WORKER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("talkdude-llm".into())
                .stack_size(16 * 1024 * 1024)
                .spawn(move || run_worker(rx))
                .expect("spawn llm worker");
            Mutex::new(tx)
        })
        .lock()
        .unwrap()
        .clone()
}

fn unload_if(path: &PathBuf) {
    let loaded = LOADED.lock().unwrap().clone();
    if loaded.as_ref() == Some(path) {
        let _ = worker().send(Job::Unload);
        *LOADED.lock().unwrap() = None;
    }
}


fn run_worker(rx: mpsc::Receiver<Job>) {
    let mut backend = match LlamaBackend::init() {
        Ok(b) => b,
        Err(e) => {
            // Answer every job with the error.
            for job in rx {
                let msg = format!("Could not start the on-device engine: {e}");
                match job {
                    Job::Load { reply, .. } | Job::Chat { reply, .. } => {
                        let _ = reply.send(Err(msg.clone()));
                    }
                    Job::Unload => {}
                }
            }
            return;
        }
    };
    backend.void_logs();
    let mut current: Option<Loaded> = None;

    for job in rx {
        match job {
            Job::Unload => current = None,
            Job::Load {
                path,
                n_ctx,
                n_threads,
                reply,
            } => {
                current = None;
                let params = LlamaModelParams::default();
                let res = LlamaModel::load_from_file(&backend, &path, &params)
                    .map(|model| {
                        current = Some(Loaded {
                            model,
                            n_ctx,
                            n_threads,
                        });
                    })
                    .map_err(|e| format!("Could not load the model: {e}"));
                if res.is_ok() {
                    *LOADED.lock().unwrap() = Some(path);
                }
                let _ = reply.send(res);
            }
            Job::Chat {
                messages,
                params,
                on_token,
                reply,
            } => {
                let res = match &current {
                    None => Err("No on-device model is loaded.".to_string()),
                    Some(l) => generate(&backend, l, &messages, &params, &on_token),
                };
                let _ = reply.send(res);
            }
        }
    }
}

fn generate(
    backend: &LlamaBackend,
    l: &Loaded,
    messages: &[ChatMessage],
    params: &GenParams,
    on_token: &Channel<String>,
) -> Result<(), String> {
    llm_core::generate(backend, l, messages, params, &mut |t| { let _ = on_token.send(t); })
}

fn default_threads() -> i32 {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    // Leave a core or two for the UI; phones have big.LITTLE cores.
    // Phones: the fast "big" cores are usually 4 or fewer.
    let max = if cfg!(target_os = "android") { 4 } else { 8 };
    (n.saturating_sub(2)).clamp(1, max) as i32
}

#[tauri::command]
pub async fn llm_load(app: AppHandle, file: String, n_ctx: Option<u32>) -> Result<(), String> {
    let path = model_path(&app, &file)?;
    if !path.exists() {
        return Err("This model is not downloaded yet.".into());
    }
    if LOADED.lock().unwrap().as_ref() == Some(&path) {
        return Ok(());
    }
    let (reply, rx) = mpsc::channel();
    worker()
        .send(Job::Load {
            path,
            n_ctx: n_ctx.unwrap_or(4096),
            n_threads: default_threads(),
            reply,
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Err("engine stopped".into())))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn llm_chat(
    messages: Vec<ChatMessage>,
    params: GenParams,
    on_token: Channel<String>,
) -> Result<(), String> {
    let (reply, rx) = mpsc::channel();
    worker()
        .send(Job::Chat {
            messages,
            params,
            on_token,
            reply,
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Err("engine stopped".into())))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn llm_stop() {
    GEN_CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn llm_info() -> serde_json::Value {
    serde_json::json!({
        "native": true,
        "threads": default_threads(),
        "loaded": LOADED.lock().unwrap().as_ref().and_then(|p| p.file_name()).map(|f| f.to_string_lossy().to_string()),
    })
}
