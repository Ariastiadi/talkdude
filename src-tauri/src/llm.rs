//! Native on-device AI: llama.cpp compiled into the app (via llama-cpp-2).
//!
//! Much faster than the WebAssembly engine because it uses the CPU's SIMD
//! instructions and several threads. Models are plain GGUF files stored in the
//! app's private data folder (`<app data>/models`).

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::mtmd::{mtmd_default_marker, MtmdContext, MtmdContextParams};
use serde::Serialize;

use crate::llm_core::{self, ChatMessage, GenParams, Loaded, STOP_EPOCH};
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
    // Clean up leftovers of an interrupted import once per start, never while one runs.
    let clean = !IMPORTING.load(Ordering::SeqCst) && !CLEANED.swap(true, Ordering::SeqCst);
    for entry in fs::read_dir(models_dir(&app)?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Leftovers of an interrupted import are useless; downloads keep theirs for resuming.
        if clean && name.ends_with(".gguf.import") {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        if name.ends_with(".gguf") {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ModelFile { file: name, size });
        }
    }
    Ok(out)
}

/// Runs off the main thread: unloading may wait for a reply that is still being written.
#[tauri::command]
pub async fn llm_delete(app: AppHandle, file: String) -> Result<(), String> {
    let path = model_path(&app, &file)?;
    tauri::async_runtime::spawn_blocking(move || {
        if LOADED.lock().unwrap().as_ref().map(|(m, v)| m == &path || v.as_ref() == Some(&path)).unwrap_or(false) {
            // Stop what the model is doing so it can be unloaded right away.
            STOP_EPOCH.fetch_add(1, Ordering::SeqCst);
        }
        unload_if(&path);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cancel flags of running downloads, one per file (so cancelling one doesn't stop another).
fn downloads() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static D: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Streams a model from `url` into the models folder, reporting bytes written.
/// An interrupted download is resumed from where it stopped (HTTP Range).
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
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = downloads().lock().unwrap();
        if map.contains_key(&file) {
            return Err("This model is already downloading.".into());
        }
        map.insert(file.clone(), cancel.clone());
    }
    let res = download_to(&url, &part, &path, &cancel, &on_progress).await;
    downloads().lock().unwrap().remove(&file);
    res
}

async fn download_to(
    url: &str,
    part: &PathBuf,
    path: &PathBuf,
    cancel: &AtomicBool,
    on_progress: &Channel<u64>,
) -> Result<(), String> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // A stalled connection (e.g. Wi-Fi to mobile data) ends instead of hanging forever.
        .read_timeout(Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let have = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        if status == 416 {
            let _ = fs::remove_file(part);
        }
        return Err(format!("Download failed (HTTP {status}). Please try again."));
    }
    let resumed = status == 206 && have > 0;
    let mut written: u64 = if resumed { have } else { 0 };
    let total = resp.content_length().map(|l| l + written).unwrap_or(0);
    let mut out = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(part)
        .map_err(|e| e.to_string())?;
    let _ = on_progress.send(written);
    let mut last_report: u64 = written;
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(out);
            let _ = fs::remove_file(part);
            return Err("Download cancelled.".into());
        }
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = out.write_all(&chunk) {
                    drop(out);
                    let _ = fs::remove_file(part);
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
                // Keep the partial file: the next try continues from here.
                let _ = out.flush();
                return Err(format!("Download interrupted ({e}). Tap Download again to continue."));
            }
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && written != total {
        return Err("Download was incomplete. Tap Download again to continue.".into());
    }
    fs::rename(part, path).map_err(|e| e.to_string())?;
    let _ = on_progress.send(written);
    Ok(())
}

/// Cancels the download of `file`, or every download when no file is given.
#[tauri::command]
pub fn llm_cancel_download(file: Option<String>) {
    let map = downloads().lock().unwrap();
    for (f, flag) in map.iter() {
        if file.as_deref().map(|x| x == f).unwrap_or(true) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

static IMPORTING: AtomicBool = AtomicBool::new(false);
static CLEANED: AtomicBool = AtomicBool::new(false);

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
    let part = path.with_extension("gguf.import");
    IMPORTING.store(!last, Ordering::SeqCst);
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
        mmproj: Option<PathBuf>,
        n_ctx: u32,
        n_threads: i32,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Chat {
        messages: Vec<ChatMessage>,
        params: GenParams,
        on_token: Channel<String>,
        images: Vec<Vec<u8>>,
        /// Request id (from the app), so Stop cancels only this reply.
        req_id: u64,
        /// Value of STOP_EPOCH when the request was made; "stop everything" bumps it.
        epoch: u64,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Unload {
        reply: Option<mpsc::Sender<()>>,
    },
}

static WORKER: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();
/// Model file (and vision file) currently in memory.
static LOADED: Mutex<Option<(PathBuf, Option<PathBuf>)>> = Mutex::new(None);

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

/// Unloads the model if it is `path`, and waits so the file can be deleted (Windows locks mapped files).
fn unload_if(path: &PathBuf) {
    let loaded = LOADED.lock().unwrap().clone();
    if loaded.as_ref().map(|(m, v)| m == path || v.as_ref() == Some(path)).unwrap_or(false) {
        let (tx, rx) = mpsc::channel();
        if worker().send(Job::Unload { reply: Some(tx) }).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(60));
        }
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
                    Job::Unload { reply } => {
                        if let Some(r) = reply {
                            let _ = r.send(());
                        }
                    }
                }
            }
            return;
        }
    };
    backend.void_logs();
    let mut current: Option<Loaded> = None;

    for job in rx {
        match job {
            Job::Unload { reply } => {
                current = None;
                if let Some(r) = reply {
                    let _ = r.send(());
                }
            }
            Job::Load {
                path,
                mmproj,
                n_ctx,
                n_threads,
                reply,
            } => {
                // Forget the old model first, so a failed load never leaves a stale "loaded" name.
                current = None;
                *LOADED.lock().unwrap() = None;
                let params = LlamaModelParams::default();
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    LlamaModel::load_from_file(&backend, &path, &params)
                }));
                let res = match res {
                    Ok(Ok(model)) => {
                        // Optional "eyes": if they fail, the model still works for text.
                        let mtmd = mmproj.as_ref().and_then(|mp| {
                            let params = MtmdContextParams {
                                use_gpu: false,
                                print_timings: false,
                                n_threads,
                                media_marker: std::ffi::CString::new(mtmd_default_marker()).ok()?,
                                image_min_tokens: -1,
                                image_max_tokens: llm_core::image_tokens(n_ctx),
                            };
                            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                MtmdContext::init_from_file(&mp.to_string_lossy(), &model, &params)
                            }));
                            match r {
                                Ok(Ok(m)) => Some(m),
                                _ => None,
                            }
                        });
                        let loaded_eyes = if mtmd.is_some() { mmproj.clone() } else { None };
                        current = Some(Loaded { model, n_ctx, n_threads, mtmd });
                        *LOADED.lock().unwrap() = Some((path, loaded_eyes));
                        Ok(())
                    }
                    Ok(Err(e)) => Err(format!("Could not load the model: {e}. The file may be damaged; delete it and download again.")),
                    Err(_) => Err("The on-device engine crashed while loading the model. Try a smaller model.".to_string()),
                };
                let _ = reply.send(res);
            }
            Job::Chat {
                messages,
                params,
                on_token,
                images,
                req_id,
                epoch,
                reply,
            } => {
                let cancelled = move || STOP_EPOCH.load(Ordering::SeqCst) != epoch || stopped().lock().unwrap().contains(&req_id);
                let res = match &current {
                    None => Err("No on-device model is loaded.".to_string()),
                    Some(l) => {
                        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            generate(&backend, l, &messages, &params, &images, &cancelled, &on_token)
                        }));
                        match r {
                            Ok(x) => x,
                            Err(_) => Err("CRASHED".to_string()),
                        }
                    }
                };
                let res = if matches!(&res, Err(e) if e == "CRASHED") {
                    // The model state can't be trusted after a panic: load it again next time.
                    current = None;
                    *LOADED.lock().unwrap() = None;
                    Err("The on-device engine hit an error. Please try again.".to_string())
                } else {
                    res
                };
                stopped().lock().unwrap().remove(&req_id);
                let _ = reply.send(res);
            }
        }
    }
}

/// Ids of replies the user stopped.
fn stopped() -> &'static Mutex<HashSet<u64>> {
    static S: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

fn generate(
    backend: &LlamaBackend,
    l: &Loaded,
    messages: &[ChatMessage],
    params: &GenParams,
    images: &[Vec<u8>],
    cancelled: &dyn Fn() -> bool,
    on_token: &Channel<String>,
) -> Result<(), String> {
    llm_core::generate(backend, l, messages, params, images, cancelled, &mut |t| { let _ = on_token.send(t); })
}

fn default_threads() -> i32 {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    // Leave a core or two for the UI; phones have big.LITTLE cores.
    // Phones: the fast "big" cores are usually 4 or fewer.
    let max = if cfg!(target_os = "android") { 4 } else { 8 };
    (n.saturating_sub(2)).clamp(1, max) as i32
}

#[tauri::command]
/// Loads a model (and its "eyes"). Returns true when the eyes are loaded.
pub async fn llm_load(app: AppHandle, file: String, n_ctx: Option<u32>, mmproj: Option<String>) -> Result<bool, String> {
    let path = model_path(&app, &file)?;
    if !path.exists() {
        return Err("This model is not downloaded yet.".into());
    }
    let eyes = match mmproj {
        Some(f) => {
            let p = model_path(&app, &f)?;
            if p.exists() { Some(p) } else { None }
        }
        None => None,
    };
    if LOADED.lock().unwrap().as_ref() == Some(&(path.clone(), eyes.clone())) {
        return Ok(eyes.is_some());
    }
    let (reply, rx) = mpsc::channel();
    worker()
        .send(Job::Load {
            path,
            mmproj: eyes,
            n_ctx: n_ctx.unwrap_or(4096),
            n_threads: default_threads(),
            reply,
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Err("engine stopped".into())))
        .await
        .map_err(|e| e.to_string())??;
    Ok(LOADED.lock().unwrap().as_ref().map(|(_, v)| v.is_some()).unwrap_or(false))
}

#[tauri::command]
pub async fn llm_chat(
    messages: Vec<ChatMessage>,
    params: GenParams,
    images: Option<Vec<String>>,
    req_id: Option<u64>,
    on_token: Channel<String>,
) -> Result<(), String> {
    use base64::Engine as _;
    let images: Vec<Vec<u8>> = images
        .unwrap_or_default()
        .iter()
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .collect();
    let (reply, rx) = mpsc::channel();
    let epoch = STOP_EPOCH.load(Ordering::SeqCst);
    worker()
        .send(Job::Chat {
            messages,
            params,
            on_token,
            images,
            req_id: req_id.unwrap_or(0),
            epoch,
            reply,
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Err("engine stopped".into())))
        .await
        .map_err(|e| e.to_string())?
}

/// Stops one reply (by its request id), or every running and queued reply when no id is given.
#[tauri::command]
pub fn llm_stop(req_id: Option<u64>) {
    match req_id {
        Some(id) => {
            let mut s = stopped().lock().unwrap();
            if s.len() > 1000 {
                s.clear();
            }
            s.insert(id);
        }
        None => {
            STOP_EPOCH.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub fn llm_info() -> serde_json::Value {
    serde_json::json!({
        "native": true,
        "threads": default_threads(),
        "loaded": LOADED.lock().unwrap().as_ref().and_then(|(p, _)| p.file_name()).map(|f| f.to_string_lossy().to_string()),
        "vision": LOADED.lock().unwrap().as_ref().map(|(_, v)| v.is_some()).unwrap_or(false),
    })
}
