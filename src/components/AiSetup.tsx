import { Show, createSignal } from "solid-js";
import { downloadProgress, cancelLocalDownload, localModelInfo, formatSize, DEFAULT_LOCAL_MODEL, localSupported } from "../lib/api/local";
import { startOnDeviceSetup } from "../lib/stores/ai";
import { openSettings } from "../lib/stores/settings";
import "./AiSetup.css";

/** Download progress for one on-device model (shared by onboarding, chat and Settings). */
export function DownloadBar(props: { modelKey: string }) {
  const info = () => localModelInfo(props.modelKey)!;
  const p = () => downloadProgress()[props.modelKey] ?? 0;
  return (
    <div class="dl-bar">
      <div class="dl-bar-track"><div class="dl-bar-fill" style={{ width: `${Math.round(p() * 100)}%` }} /></div>
      <div class="dl-bar-row md-typescale-label-medium">
        <span>{Math.round(p() * 100)}% · {formatSize(info().size * p())} of {formatSize(info().size)}</span>
        <button type="button" class="dl-cancel" onClick={() => cancelLocalDownload(props.modelKey)}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Shown when no AI is set up yet (no key, no provider, no on-device model),
 * so the very first message never ends in a dead end.
 */
export default function AiSetupCard(props: { compact?: boolean }) {
  const key = DEFAULT_LOCAL_MODEL;
  const [error, setError] = createSignal<string | null>(null);
  const downloading = () => downloadProgress()[key] !== undefined;

  const start = async () => {
    setError(null);
    try { await startOnDeviceSetup(key); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div class={`ai-setup ${props.compact ? "compact" : ""}`}>
      <Show when={downloading()} fallback={
        <>
          <div class="ai-setup-title md-typescale-title-medium">Choose an AI to start chatting</div>
          <p class="ai-setup-text md-typescale-body-medium">
            talkdude is free. Run a small AI right on this device with no key and no limits, or add a free API key for smarter answers.
          </p>
          <Show when={error()}><div class="ai-setup-error md-typescale-body-small">{error()}</div></Show>
          <div class="ai-setup-actions">
            <Show when={localSupported()}>
              <button type="button" class="td-btn td-btn-primary" onClick={start}>
                <md-icon>download</md-icon>
                <span>Free on-device AI · {formatSize(localModelInfo(key)!.size)}</span>
              </button>
            </Show>
            <button type="button" class="td-btn td-btn-outline" onClick={() => openSettings("gemini")}>
              <md-icon>key</md-icon>
              <span>Add a free API key</span>
            </button>
          </div>
        </>
      }>
        <div class="ai-setup-title md-typescale-title-medium">Getting your on-device AI ready…</div>
        <p class="ai-setup-text md-typescale-body-medium">
          One-time download of {localModelInfo(key)!.name}. Keep talkdude open; after this it works offline.
        </p>
        <DownloadBar modelKey={key} />
      </Show>
    </div>
  );
}
