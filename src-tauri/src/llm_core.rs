//! llama.cpp prompt formatting and token generation (no Tauri types, so it can be tested alone).

use std::num::NonZeroU32;
use std::sync::atomic::AtomicU64;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::mtmd::{mtmd_default_marker, MtmdBitmap, MtmdContext, MtmdInputText};
use llama_cpp_2::sampling::LlamaSampler;
use serde::Deserialize;

/// Bumped by "Stop". A generation started with an older value stops at the next token.
pub static STOP_EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GenParams {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<i32>,
    pub repeat_penalty: Option<f32>,
    /// For "thinking" models (Qwen 3.5): answer directly, without thinking first.
    pub no_think: Option<bool>,
}

pub struct Loaded {
    pub model: LlamaModel,
    pub n_ctx: u32,
    pub n_threads: i32,
    /// Vision projector ("eyes"), when the model has one loaded.
    pub mtmd: Option<MtmdContext>,
}

/// Picture budget per image (tokens): small enough for phones.
pub fn image_tokens(n_ctx: u32) -> i32 {
    if n_ctx <= 4096 { 256 } else { 512 }
}

pub fn build_prompt(model: &LlamaModel, messages: &[ChatMessage]) -> Result<String, String> {
    let chat: Vec<LlamaChatMessage> = messages
        .iter()
        .map(|m| LlamaChatMessage::new(m.role.clone(), m.content.replace('\0', "")))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    if let Ok(tmpl) = model.chat_template(None) {
        if let Ok(p) = model.apply_chat_template(&tmpl, &chat, true) {
            return Ok(p);
        }
    }
    // Fallback: ChatML, understood by most instruction-tuned models.
    let mut p = String::new();
    for m in messages {
        p.push_str(&format!("<|im_start|>{}\n{}<|im_end|>\n", m.role, m.content.replace('\0', "")));
    }
    p.push_str("<|im_start|>assistant\n");
    Ok(p)
}

pub fn generate(
    backend: &LlamaBackend,
    l: &Loaded,
    messages: &[ChatMessage],
    params: &GenParams,
    images: &[Vec<u8>],
    cancelled: &dyn Fn() -> bool,
    on_token: &mut dyn FnMut(String),
) -> Result<(), String> {
    if cancelled() {
        return Ok(());
    }
    let model = &l.model;
    let vocab = model.vocab();
    let max_tokens = params.max_tokens.unwrap_or(768).clamp(16, 4096);
    let n_ctx = l.n_ctx.max(512);

    // Fit the prompt: drop the oldest turns first (keeping the system prompt), then
    // shorten the last message (keeping its end, where the question usually is), then
    // shorten the system prompt (keeping its start). Never cut the template itself.
    let mut msgs: Vec<ChatMessage> = messages.to_vec();
    let images: &[Vec<u8>] = if l.mtmd.is_some() { images } else { &[] };
    // Pictures go where the markers are, at the start of the newest user message.
    let marker_prefix = if images.is_empty() { String::new() } else { format!("{}\n", mtmd_default_marker().repeat(images.len())) };
    if !images.is_empty() {
        if let Some(last) = msgs.iter_mut().rev().find(|m| m.role == "user") {
            last.content = format!("{marker_prefix}{}", last.content);
        }
    }
    let image_budget = images.len() as u32 * (image_tokens(n_ctx) as u32 + 16);
    let budget = (n_ctx - max_tokens.min(n_ctx / 2)).saturating_sub(image_budget).max(256);
    let no_think = params.no_think.unwrap_or(false);
    let finish = |p: String| -> String {
        // Qwen-style models skip their thinking when the answer starts with an empty think block.
        if no_think && p.ends_with("<|im_start|>assistant\n") {
            format!("{p}<think>\n\n</think>\n\n")
        } else {
            p
        }
    };
    let mut rounds = 0;
    let mut final_prompt: Option<String> = None;
    let tokens = loop {
        let prompt = finish(build_prompt(model, &msgs)?);
        let toks = vocab.tokenize(prompt.as_bytes(), false, true);
        if toks.len() as u32 <= budget || rounds > 400 {
            if toks.len() as u32 <= budget {
                final_prompt = Some(prompt);
                break toks;
            }
            // Last resort: keep the end.
            let keep = budget as usize;
            break toks[toks.len().saturating_sub(keep)..].to_vec();
        }
        rounds += 1;
        let has_system = msgs.first().map(|m| m.role == "system").unwrap_or(false);
        let first_turn = if has_system { 1 } else { 0 };
        if msgs.len() > first_turn + 1 {
            msgs.remove(first_turn);
            continue;
        }
        let last = msgs.len() - 1;
        let last_len = msgs[last].content.chars().count();
        let sys_len = if has_system { msgs[0].content.chars().count() } else { 0 };
        if last_len > 400 && (last_len >= sys_len || sys_len <= 400) {
            // Keep the picture markers at the front and the end of the text (the question).
            let body: String = msgs[last].content.strip_prefix(marker_prefix.as_str()).unwrap_or(&msgs[last].content).to_string();
            let body_len = body.chars().count();
            let keep = body_len * 7 / 10;
            let tail: String = body.chars().skip(body_len - keep).collect();
            msgs[last].content = if msgs[last].content.starts_with(marker_prefix.as_str()) { format!("{marker_prefix}{tail}") } else { tail };
        } else if has_system && sys_len > 400 {
            let keep = sys_len * 7 / 10;
            msgs[0].content = msgs[0].content.chars().take(keep).collect();
        } else {
            let keep = budget as usize;
            break toks[toks.len().saturating_sub(keep)..].to_vec();
        }
    };

    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_batch(512)
        .with_n_ubatch(512)
        .with_n_threads(l.n_threads)
        .with_n_threads_batch(l.n_threads);
    let mut ctx = model
        .new_context(backend, ctx_params)
        .map_err(|e| format!("Not enough memory for the on-device model ({e})"))?;

    let mut batch = LlamaBatch::new(512, 1);
    let mut pos: i32;
    match (&l.mtmd, final_prompt) {
        (Some(mt), Some(prompt)) if !images.is_empty() => {
            // Text and pictures together: llama.cpp's multimodal helper encodes the images.
            let bitmaps: Vec<MtmdBitmap> = images
                .iter()
                .map(|b| MtmdBitmap::from_buffer(mt, b, false))
                .collect::<Result<_, _>>()
                .map_err(|_| "Couldn't read the picture. Try a JPG or PNG.".to_string())?;
            let refs: Vec<&MtmdBitmap> = bitmaps.iter().collect();
            let chunks = mt
                .tokenize(MtmdInputText { text: prompt, add_special: false, parse_special: true }, &refs)
                .map_err(|e| format!("Couldn't prepare the picture ({e})"))?;
            let n_past = chunks
                .eval_chunks(mt, &ctx, 0, 0, 512, true)
                .map_err(|e| format!("Couldn't look at the picture ({e})"))?;
            pos = n_past;
            if cancelled() {
                return Ok(());
            }
        }
        _ => {
            // Prompt in chunks of n_batch.
            let n_prompt = tokens.len();
            for (start, chunk) in tokens.chunks(512).enumerate() {
                batch.clear();
                for (i, t) in chunk.iter().enumerate() {
                    let p = (start * 512 + i) as i32;
                    let is_last = start * 512 + i == n_prompt - 1;
                    batch.add(*t, p, &[0], is_last).map_err(|e| e.to_string())?;
                }
                ctx.decode(&mut batch).map_err(|e| format!("Prompt failed: {e}"))?;
                if cancelled() {
                    return Ok(());
                }
            }
            pos = n_prompt as i32;
        }
    }

    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::penalties(vocab.n_tokens(), 64, params.repeat_penalty.unwrap_or(1.1), 0.0, 0.0),
        LlamaSampler::top_k(params.top_k.unwrap_or(40)),
        LlamaSampler::top_p(params.top_p.unwrap_or(0.95), 1),
        LlamaSampler::temp(params.temperature.unwrap_or(0.8)),
        LlamaSampler::dist(rand_seed()),
    ]);

    let mut pending: Vec<u8> = Vec::new();
    let mut out = String::new();
    for _ in 0..max_tokens {
        if cancelled() || pos as u32 >= n_ctx {
            break;
        }
        // After the multimodal helper the batch is empty: -1 means "the last logits".
        let token = sampler.sample(&ctx, if batch.n_tokens() > 0 { batch.n_tokens() - 1 } else { -1 });
        sampler.accept(token);
        if vocab.is_eog(token) {
            break;
        }
        pending.extend_from_slice(&vocab.token_to_piece(token, false, None));
        // Only send complete UTF-8 (emoji can span several tokens).
        match std::str::from_utf8(&pending) {
            Ok(s) => {
                out.push_str(s);
                on_token(s.to_string());
                pending.clear();
            }
            Err(e) if e.error_len().is_some() => {
                let s = String::from_utf8_lossy(&pending).to_string();
                on_token(s);
                pending.clear();
            }
            Err(_) => {}
        }
        batch.clear();
        batch.add(token, pos, &[0], true).map_err(|e| e.to_string())?;
        pos += 1;
        ctx.decode(&mut batch).map_err(|e| format!("Generation failed: {e}"))?;
    }
    Ok(())
}

pub fn rand_seed() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() ^ (d.as_secs() as u32))
        .unwrap_or(1234)
}

