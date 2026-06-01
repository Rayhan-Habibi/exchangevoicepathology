import { useState, useRef, useCallback, useEffect } from "react";

/* ────────────────────────── constants ────────────────────────── */
const API_URL = "https://rayhanhabibi-exchange.hf.space/predict";
const MAX_RECORD_MS = 3000; // 3-second limit

/* ────────────────────────── helpers ──────────────────────────── */

/**
 * Encode a Blob (webm/ogg from MediaRecorder) into a proper WAV file
 * so the backend always receives PCM audio that librosa can read.
 */
async function blobToWav(blob) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000,
  });
  const arrayBuf = await blob.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(arrayBuf);

  const numChannels = 1;
  const sampleRate = decoded.sampleRate;
  const samples = decoded.getChannelData(0); // mono
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  /* — WAV header — */
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true); // 16-bit
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  /* — PCM data — */
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  await audioCtx.close();
  return new Blob([buffer], { type: "audio/wav" });
}

/* ────────────────────────── icons (inline SVGs) ─────────────── */
function MicIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function StopIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function UploadIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-6 h-6" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ────────────────────────── main component ──────────────────── */
export default function App() {
  /* state */
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { prediction, confidence }
  const [error, setError] = useState(null);
  const [countdown, setCountdown] = useState(3);

  /* refs */
  const mediaRec = useRef(null);
  const chunks = useRef([]);
  const timerRef = useRef(null);
  const countdownRef = useRef(null);
  const fileInputRef = useRef(null);

  /* ── cleanup on unmount ── */
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      clearInterval(countdownRef.current);
    };
  }, []);

  /* ── stop helper ── */
  const stopRecording = useCallback(() => {
    clearTimeout(timerRef.current);
    clearInterval(countdownRef.current);
    if (mediaRec.current && mediaRec.current.state !== "inactive") {
      mediaRec.current.stop();
    }
  }, []);

  /* ── start helper ── */
  const startRecording = useCallback(async () => {
    setResult(null);
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRec.current = recorder;
      chunks.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };

      recorder.onstop = async () => {
        /* release mic */
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);

        const rawBlob = new Blob(chunks.current, { type: recorder.mimeType });

        setLoading(true);
        try {
          const wavBlob = await blobToWav(rawBlob);

          const form = new FormData();
          form.append("file", wavBlob, "recording.wav");

          const res = await fetch(API_URL, { method: "POST", body: form });
          if (!res.ok) {
            const detail = await res.text();
            throw new Error(detail || `Server responded with ${res.status}`);
          }
          const data = await res.json();
          setResult(data);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      };

      recorder.start();
      setRecording(true);
      setCountdown(3);

      /* countdown ticker */
      let remaining = 3;
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);
        if (remaining <= 0) clearInterval(countdownRef.current);
      }, 1000);

      /* auto-stop after 3 s */
      timerRef.current = setTimeout(() => stopRecording(), MAX_RECORD_MS);
    } catch (err) {
      setError("Microphone access denied. Please allow microphone permissions.");
    }
  }, [stopRecording]);

  /* ── toggle ── */
  const handleToggle = () => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  /* ── file upload handler ── */
  const handleFileUpload = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset previous state
    setResult(null);
    setError(null);
    setLoading(true);

    try {
      const form = new FormData();
      form.append("file", file, file.name);

      const res = await fetch(API_URL, { method: "POST", body: form });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `Server responded with ${res.status}`);
      }
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      // Reset the input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  /* ── derived ── */
  const isHealthy = result?.prediction === "Healthy";
  const confidencePct = result ? Math.round(result.confidence * 100) : 0;

  /* ────────────────────────── render ─────────────────────────── */
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4" style={{ background: "var(--color-bg)" }}>
      {/* card */}
      <div
        className="w-full max-w-md rounded-2xl p-8 flex flex-col items-center gap-6 shadow-2xl border animate-fade-in-up"
        style={{
          background: "var(--color-card)",
          borderColor: "var(--color-card-border)",
        }}
      >
        {/* title */}
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--color-text)" }}>
            Voice Pathology Detector
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
            Says "Aaaa" for 3 seconds to analyze your voice
          </p>
        </div>

        {/* record button */}
        <div className="relative flex items-center justify-center">
          {/* animated ring while recording */}
          {recording && (
            <span
              className="absolute w-24 h-24 rounded-full animate-pulse-ring"
              style={{ background: "var(--color-pathological)", opacity: 0.3 }}
            />
          )}

          <button
            id="record-btn"
            onClick={handleToggle}
            disabled={loading}
            className="relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer focus:outline-none focus:ring-4"
            style={{
              background: recording ? "var(--color-pathological)" : "var(--color-accent)",
              color: "#fff",
              focusRingColor: recording ? "rgba(248,113,113,0.4)" : "rgba(99,102,241,0.4)",
              opacity: loading ? 0.5 : 1,
            }}
          >
            {recording ? <StopIcon className="w-8 h-8" /> : <MicIcon className="w-8 h-8" />}
          </button>
        </div>

        {/* divider */}
        <div className="flex items-center gap-3 w-full" style={{ color: "var(--color-text-muted)" }}>
          <div className="flex-1 h-px" style={{ background: "var(--color-card-border)" }} />
          <span className="text-xs font-medium uppercase tracking-widest">or</span>
          <div className="flex-1 h-px" style={{ background: "var(--color-card-border)" }} />
        </div>

        {/* upload button */}
        <input
          ref={fileInputRef}
          id="file-input"
          type="file"
          accept="audio/wav, audio/x-wav, .wav"
          onChange={handleFileUpload}
          className="hidden"
        />
        <button
          id="upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || recording}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer focus:outline-none focus:ring-4"
          style={{
            background: "transparent",
            color: "var(--color-accent)",
            border: "1.5px solid var(--color-accent)",
            opacity: loading || recording ? 0.4 : 1,
          }}
        >
          <UploadIcon className="w-4 h-4" />
          Upload .WAV File
        </button>

        {/* status text */}
        <p className="text-sm font-medium h-5" style={{ color: "var(--color-text-muted)" }}>
          {recording && `Recording… ${countdown}s remaining`}
          {loading && "Analyzing…"}
          {!recording && !loading && !result && !error && "Tap the mic or upload a file"}
        </p>

        {/* loading spinner */}
        {loading && (
          <div className="flex items-center gap-2" style={{ color: "var(--color-accent)" }}>
            <Spinner />
            <span className="text-sm font-medium">Processing audio…</span>
          </div>
        )}

        {/* result */}
        {result && (
          <div className="w-full rounded-xl p-5 text-center animate-fade-in-up" style={{ background: "var(--color-bg)" }}>
            <p className="text-xs uppercase tracking-widest mb-2 font-semibold" style={{ color: "var(--color-text-muted)" }}>
              Result
            </p>
            <p
              className="text-3xl font-extrabold"
              style={{ color: isHealthy ? "var(--color-healthy)" : "var(--color-pathological)" }}
            >
              {result.prediction}
            </p>
            <div className="mt-3 flex items-center justify-center gap-2">
              {/* confidence bar */}
              <div className="w-32 h-2 rounded-full overflow-hidden" style={{ background: "var(--color-card-border)" }}>
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${confidencePct}%`,
                    background: isHealthy ? "var(--color-healthy)" : "var(--color-pathological)",
                  }}
                />
              </div>
              <span className="text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>
                {confidencePct}%
              </span>
            </div>
          </div>
        )}

        {/* error */}
        {error && (
          <div className="w-full rounded-xl p-4 text-center text-sm animate-fade-in-up" style={{ background: "rgba(248,113,113,0.1)", color: "var(--color-pathological)" }}>
            {error}
          </div>
        )}
      </div>

      {/* footer */}
      <p className="mt-6 text-xs" style={{ color: "var(--color-text-muted)" }}>
        For research purposes only — not a medical diagnosis.
      </p>
    </div>
  );
}
