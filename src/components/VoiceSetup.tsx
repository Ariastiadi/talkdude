import { Show, createSignal } from "solid-js";
import { ensureStt, sttModel, sttProgress, sttError, ORT_WASM_BYTES } from "../lib/voice/stt";
import { formatSize } from "../lib/api/local";

/** One-time download prompt for voice input (Whisper on the device). */
export default function VoiceSetupCard(props: { onReady?: () => void; onCancel?: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const total = () => sttModel().bytes + ORT_WASM_BYTES;
  const start = async () => {
    setBusy(true);
    try {
      await ensureStt();
      props.onReady?.();
    } catch { /* message shown from sttError */ } finally {
      setBusy(false);
    }
  };
  return (
    <div class="voice-setup">
      <div class="voice-setup-title md-typescale-title-small"><md-icon>mic</md-icon><span>Voice input</span></div>
      <p class="md-typescale-body-small voice-setup-text">
        talkdude turns your voice into text right on this device ({sttModel().name}), so nothing you say is sent anywhere.
        It needs a one-time download of {formatSize(total())}. Indonesian and English are recognised automatically.
      </p>
      <Show when={sttProgress() !== null} fallback={
        <div class="voice-setup-actions">
          <Show when={props.onCancel}>
            <button type="button" class="td-btn td-btn-sm" onClick={() => props.onCancel?.()}><span>Not now</span></button>
          </Show>
          <button type="button" class="td-btn td-btn-primary td-btn-sm" disabled={busy()} onClick={start}>
            <md-icon>download</md-icon><span>Download {formatSize(total())}</span>
          </button>
        </div>
      }>
        <div class="dl-bar">
          <div class="dl-bar-track"><div class="dl-bar-fill" style={{ width: `${Math.round((sttProgress() ?? 0) * 100)}%` }} /></div>
          <div class="dl-bar-row md-typescale-label-medium">
            <span>{Math.round((sttProgress() ?? 0) * 100)}% · {formatSize(total() * (sttProgress() ?? 0))} of {formatSize(total())}</span>
          </div>
        </div>
      </Show>
      <Show when={sttError()}>
        <div class="md-typescale-body-small voice-setup-error">{sttError()}</div>
      </Show>
    </div>
  );
}
