import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  sendMessage, isStreaming, sendBusy, messages, addAttachment, hasPendingUploads, chatError, stopStreaming,
  pendingAttachments, removeAttachment,
} from "../lib/stores/chat";
import { startRecording, type Recording } from "../lib/voice/mic";
import { transcribe, sttDownloaded } from "../lib/voice/stt";
import { speak, stopSpeaking, ttsSupported } from "../lib/voice/tts";
import VoiceSetupCard from "./VoiceSetup";
import "./VoiceMode.css";

type Phase = "setup" | "listening" | "transcribing" | "thinking" | "speaking" | "paused";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(150);
  }
  return true;
}

const replyText = (i: number) => {
  const m = messages[i];
  if (!m || m.role !== "model") return "";
  return m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
};

/**
 * Talk with the AI like a phone call: talkdude listens, turns your words into
 * text on the device, sends them, reads the answer aloud and listens again.
 * The camera can be turned on so the AI also sees what you show it.
 */
export default function VoiceMode(props: { onClose: () => void }) {
  const [phase, setPhase] = createSignal<Phase>(sttDownloaded() ? "listening" : "setup");
  const [level, setLevel] = createSignal(0);
  const [heard, setHeard] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [camera, setCamera] = createSignal(false);
  const [facing, setFacing] = createSignal<"environment" | "user">("environment");
  let video: HTMLVideoElement | undefined;
  let camStream: MediaStream | null = null;
  let rec: Recording | null = null;
  let endTurn: (() => void) | null = null;
  let alive = true;
  let running = false;
  let camToken = 0;
  let stoppedByUser = false;

  const stopCamera = () => {
    camToken++;
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
  };
  const startCamera = async () => {
    stopCamera();
    const my = camToken;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing(), width: { ideal: 1280 } }, audio: false });
      // Closed, switched off or restarted while the camera was opening: don't keep this one.
      if (!alive || my !== camToken) { s.getTracks().forEach((t) => t.stop()); return; }
      camStream = s;
      if (video) { video.srcObject = s; await video.play().catch(() => {}); }
      setCamera(true);
    } catch {
      if (my !== camToken) return;
      setCamera(false);
      setError("Couldn't open the camera. Allow camera access for talkdude and try again.");
    }
  };
  const toggleCamera = async () => {
    if (camera()) { stopCamera(); setCamera(false); } else await startCamera();
  };
  const flipCamera = async () => {
    setFacing(facing() === "environment" ? "user" : "environment");
    if (camera()) await startCamera();
  };

  /** Takes a photo from the camera preview for the AI to look at. */
  const snapshot = async (): Promise<File | null> => {
    if (!camera() || !video || !video.videoWidth) return null;
    const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }) : null;
  };

  /** Records one spoken turn. Returns the text, "" for silence, or null when stopped. */
  const listenOnce = async (): Promise<string | null> => {
    setPhase("listening");
    setLevel(0);
    let r: Recording;
    try {
      r = await startRecording({ autoStop: true, silence: { endSilence: 1.2, maxWait: 20, maxTurn: 60 }, onLevel: (l) => setLevel(l) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
    if (!alive) { r.cancel(); return null; }
    rec = r;
    const manual = new Promise<"done">((res) => { endTurn = () => res("done"); });
    const why = await Promise.race([r.ended, manual]);
    endTurn = null;
    rec = null;
    if (why === "stopped" || !alive) { r.cancel(); return null; }
    if (why === "nothing") { r.cancel(); return ""; }
    const audio = await r.stop();
    setPhase("transcribing");
    try {
      return await transcribe(audio);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const loop = async () => {
    if (running) return;
    running = true;
    setError(null);
    let quiet = 0;
    try {
      while (alive) {
        const text = await listenOnce();
        if (!alive) break;
        if (text === null) { setPhase("paused"); break; }
        if (!text) {
          if (++quiet >= 2) { setPhase("paused"); break; }
          continue;
        }
        quiet = 0;
        setHeard(text);
        setAnswer("");
        setPhase("thinking");
        const photo = await snapshot();
        if (photo && alive) {
          await addAttachment(photo);
          await waitFor(() => !alive || !hasPendingUploads(), 30_000);
        }
        if (!alive) {
          // Closed before sending: don't leave the photo waiting in the message box.
          const att = photo && pendingAttachments.find((a) => a.file.name === photo.name);
          if (att) removeAttachment(att.id);
          break;
        }
        const before = messages.length;
        stoppedByUser = false;
        // sendMessage resolves when the answer has finished (or failed / was stopped).
        await sendMessage(text);
        // The answer is saved a moment later.
        await waitFor(() => !alive || !!chatError() || (!isStreaming() && !sendBusy() && messages.length > before && messages[messages.length - 1]?.role === "model"), 8_000);
        if (!alive) break;
        const last = messages.length - 1;
        const reply = last >= before ? replyText(last) : "";
        if (!reply) {
          if (stoppedByUser) setError(null);
          else setError(chatError() ?? (isStreaming() ? "The answer is still coming. Tap to talk again." : "No answer came back."));
          setPhase("paused");
          break;
        }
        setAnswer(reply);
        if (ttsSupported()) {
          setPhase("speaking");
          await speak(reply, messages[last]?.id ?? null);
        }
      }
    } finally {
      running = false;
    }
  };

  const tapOrb = () => {
    const p = phase();
    if (p === "listening") endTurn?.();
    else if (p === "speaking") stopSpeaking();
    else if (p === "thinking") { stoppedByUser = true; stopStreaming(); }
    else if (p === "paused") void loop();
  };

  const close = () => {
    alive = false;
    rec?.cancel();
    rec = null;
    stopSpeaking();
    stopCamera();
    props.onClose();
  };

  onMount(() => { if (phase() !== "setup") void loop(); });
  onCleanup(() => {
    alive = false;
    rec?.cancel();
    stopSpeaking();
    stopCamera();
  });

  const label = () => ({
    setup: "",
    listening: "Listening… tap when you're done",
    transcribing: "Writing down what you said…",
    thinking: "Thinking…",
    speaking: "Speaking… tap to interrupt",
    paused: "Paused. Tap to talk",
  })[phase()];

  return (
    <Portal>
      <div class="voice-mode" role="dialog" aria-label="Voice chat">
        <div class="voice-top">
          <span class="md-typescale-title-medium voice-title">Voice chat</span>
          <md-icon-button type="button" aria-label="Close voice chat" onClick={close}><md-icon>close</md-icon></md-icon-button>
        </div>

        <Show when={phase() === "setup"} fallback={
          <>
            <div class={`voice-stage ${camera() ? "with-camera" : ""}`}>
              <video ref={video} class="voice-video" muted playsinline autoplay style={{ display: camera() ? "block" : "none" }} />
              <button type="button" class={`voice-orb phase-${phase()}`} aria-label={label()} onClick={tapOrb}
                style={{ "--lvl": String(Math.min(1, level() * 12)) }}>
                <span class="voice-orb-dots" />
              </button>
            </div>
            <div class="voice-status md-typescale-title-small" aria-live="polite">{label()}</div>
            <div class="voice-transcript">
              <Show when={heard()}><div class="voice-heard md-typescale-body-medium">“{heard()}”</div></Show>
              <Show when={answer()}><div class="voice-answer md-typescale-body-medium">{answer().slice(0, 600)}{answer().length > 600 ? "…" : ""}</div></Show>
              <Show when={!ttsSupported() && answer()}>
                <div class="md-typescale-body-small voice-note">This device has no text-to-speech voice, so answers are shown as text.</div>
              </Show>
              <Show when={error()}><div class="voice-error md-typescale-body-small">{error()}</div></Show>
            </div>
            <div class="voice-controls">
              <md-icon-button type="button" aria-label={camera() ? "Turn camera off" : "Show the AI with the camera"} onClick={toggleCamera}>
                <md-icon>{camera() ? "videocam_off" : "videocam"}</md-icon>
              </md-icon-button>
              <Show when={camera()}>
                <md-icon-button type="button" aria-label="Switch camera" onClick={flipCamera}><md-icon>cameraswitch</md-icon></md-icon-button>
              </Show>
              <button type="button" class="voice-end" aria-label="End voice chat" onClick={close}><md-icon>call_end</md-icon></button>
            </div>
          </>
        }>
          <div class="voice-setup-wrap">
            <VoiceSetupCard onReady={() => { setPhase("listening"); void loop(); }} onCancel={close} />
          </div>
        </Show>
      </div>
    </Portal>
  );
}
