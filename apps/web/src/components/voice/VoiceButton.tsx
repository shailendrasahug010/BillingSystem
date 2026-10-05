import { Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { cn } from "../../lib/cn";
import { useToast } from "../ui/Toast";

/** The browser's speech recogniser (Chrome, Edge, Safari, Android Chrome); absent elsewhere. */
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this browser can listen. */
export const canListen = () => recognitionClass() !== null;

/**
 * A microphone button: tap, speak, and what was said comes back as text (in
 * Hindi or Indian English, as the app's language). Not shown where the
 * browser cannot listen.
 */
export function VoiceButton({ onText, label, className, size = 20 }: { onText(text: string): void; label: string; className?: string; size?: number }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [listening, setListening] = useState(false);
  const current = useRef<Recognition | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  const Recognizer = recognitionClass();
  if (!Recognizer) return null;

  const listen = () => {
    if (listening) {
      current.current?.abort();
      return;
    }
    const r = new Recognizer();
    r.lang = locale === "hi" ? "hi-IN" : "en-IN";
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript?.trim();
      if (text) onText(text);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast({ tone: "danger", title: t("voice.noMic"), body: t("voice.noMicHint") });
      else if (e.error === "no-speech") toast({ tone: "info", title: t("voice.noSpeech") });
      else if (e.error !== "aborted") toast({ tone: "danger", title: t("voice.failed") });
    };
    r.onend = () => {
      setListening(false);
      current.current = null;
    };
    current.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      setListening(false);
    }
  };

  return (
    <button
      type="button"
      onClick={listen}
      aria-label={listening ? t("voice.stop") : label}
      aria-pressed={listening}
      title={listening ? t("voice.listening") : label}
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-xl text-accent", listening && "bg-danger-soft text-danger", className)}
    >
      {listening && <span className="absolute inset-0 animate-ping rounded-xl bg-danger/20" aria-hidden />}
      <Mic size={size} />
    </button>
  );
}
