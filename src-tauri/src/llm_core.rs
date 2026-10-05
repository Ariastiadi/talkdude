//! llama.cpp prompt formatting and token generation (no Tauri types, so it can be tested alone).

use std::num::NonZeroU32;
use std::sync::atomic::{AtomicBool, Ordering};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::Deserialize;

pub static GEN_CANCEL: AtomicBool = AtomicBool::new(false);

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
}

pub struct Loaded {
    pub model: LlamaModel,
    pub n_ctx: u32,
    pub n_threads: i32,
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
    on_token: &mut dyn FnMut(String),
) -> Result<(), String> {
    GEN_CANCEL.store(false, Ordering::SeqCst);
    let model = &l.model;
    let vocab = model.vocab();
    let max_tokens = params.max_tokens.unwrap_or(768).clamp(16, 4096);
    let n_ctx = l.n_ctx.max(512);

    // Drop the oldest turns (keeping the system prompt) until the prompt fits.
    let mut msgs: Vec<ChatMessage> = messages.to_vec();
    let tokens = loop {
        let prompt = build_prompt(model, &msgs)?;
        let toks = vocab.tokenize(prompt.as_bytes(), false, true);
        if toks.len() as u32 + max_tokens.min(n_ctx / 2) <= n_ctx {
            break toks;
        }
        let first_turn = if msgs.first().map(|m| m.role == "system").unwrap_or(false) { 1 } else { 0 };
        if msgs.len() > first_turn + 1 {
            msgs.remove(first_turn);
        } else {
            // A single huge message: keep only its end.
            let keep = (n_ctx - max_tokens.min(n_ctx / 2)) as usize;
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

    // Prompt in chunks of n_batch.
    let mut batch = LlamaBatch::new(512, 1);
    let n_prompt = tokens.len();
    for (start, chunk) in tokens.chunks(512).enumerate() {
        batch.clear();
        for (i, t) in chunk.iter().enumerate() {
            let pos = (start * 512 + i) as i32;
            let is_last = start * 512 + i == n_prompt - 1;
            batch.add(*t, pos, &[0], is_last).map_err(|e| e.to_string())?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("Prompt failed: {e}"))?;
        if GEN_CANCEL.load(Ordering::SeqCst) {
            return Ok(());
        }
    }

    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::penalties(vocab.n_tokens(), 64, params.repeat_penalty.unwrap_or(1.1), 0.0, 0.0),
        LlamaSampler::top_k(params.top_k.unwrap_or(40)),
        LlamaSampler::top_p(params.top_p.unwrap_or(0.95), 1),
        LlamaSampler::temp(params.temperature.unwrap_or(0.8)),
        LlamaSampler::dist(rand_seed()),
    ]);

    let mut pos = n_prompt as i32;
    let mut pending: Vec<u8> = Vec::new();
    let mut out = String::new();
    for _ in 0..max_tokens {
        if GEN_CANCEL.load(Ordering::SeqCst) || pos as u32 >= n_ctx {
            break;
        }
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
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

