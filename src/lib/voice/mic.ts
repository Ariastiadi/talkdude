/**
 * Microphone recording for voice input. Records mono audio, reports the level
 * for the UI and (optionally) stops by itself when you stop talking.
 */
import { SilenceDetector, WHISPER_RATE, concatAudio, resample, rms, type SilenceOptions } from "./audio";

export interface Recording {
  /** Stops and returns 16 kHz mono audio. */
  stop(): Promise<Float32Array>;
  /** Stops and throws the audio away. */
  cancel(): void;
  /** Resolves when the recording ended by itself: "done" (speech then silence) or "nothing" (no speech). */
  ended: Promise<"done" | "nothing" | "stopped">;
}

export interface RecordOptions {
  autoStop?: boolean;
  silence?: SilenceOptions;
  onLevel?: (level: number) => void;
}

export class MicError extends Error {}

function micMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was blocked. Allow the microphone for talkdude in your settings and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is busy in another app.";
  return "Couldn't start the microphone.";
}

export async function startRecording(opts: RecordOptions = {}): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError("This device doesn't allow microphone recording here.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    throw new MicError(micMessage(e));
  }
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  let ctx: AudioContext;
  try {
    ctx = new Ctx({ sampleRate: WHISPER_RATE });
  } catch {
    ctx = new Ctx(); // some devices refuse a custom rate; resample later
  }
  // resume() can stay pending until the page may play audio, so don't wait forever.
  if (ctx.state === "suspended") await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
  if (ctx.state !== "running") {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    throw new MicError("Tap the microphone to start listening.");
  }
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is old but works everywhere (Android WebView, WebView2, Edge).
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  const detector = new SilenceDetector(opts.silence);
  let finished = false;
  let endResolve: (v: "done" | "nothing" | "stopped") => void = () => {};
  const ended = new Promise<"done" | "nothing" | "stopped">((r) => { endResolve = r; });

  const cleanup = () => {
    if (finished) return;
    finished = true;
    node.onaudioprocess = null;
    try { source.disconnect(); node.disconnect(); } catch { /* already gone */ }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };

  node.onaudioprocess = (ev) => {
    if (finished) return;
    const data = new Float32Array(ev.inputBuffer.getChannelData(0));
    chunks.push(data);
    const level = rms(data);
    opts.onLevel?.(level);
    if (opts.autoStop) {
      const state = detector.push(level, data.length / ctx.sampleRate);
      if (state === "done" || state === "nothing") endResolve(state);
    }
  };
  source.connect(node);
  // A muted gain keeps the processor running without playing the mic back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);

  const rate = ctx.sampleRate;
  return {
    ended,
    async stop() {
      cleanup();
      endResolve("stopped");
      return resample(concatAudio(chunks), rate);
    },
    cancel() {
      cleanup();
      chunks.length = 0;
      endResolve("stopped");
    },
  };
}
