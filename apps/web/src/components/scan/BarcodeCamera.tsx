import { Flashlight, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { cn } from "../../lib/cn";
import { barcodeDetector, beep } from "./barcode";

type Problem = "insecure" | "no_camera" | "denied" | "failed";

/**
 * The back camera, reading barcodes as they come into view: each new code
 * (the same one again only after a pause) goes to `onCode` with a beep, and
 * the camera keeps going for the next pack. Stops when it leaves the screen.
 */
export function BarcodeCamera({ onCode, className }: { onCode(code: string): void; className?: string }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState<{ on: boolean; track: MediaStreamTrack } | null>(null);
  const handler = useRef(onCode);
  handler.current = onCode;

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      // Cameras are for secure pages only (https, or this computer).
      setProblem(window.isSecureContext ? "no_camera" : "insecure");
      return;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const last = { code: "", at: 0 };
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        const name = (e as DOMException).name;
        setProblem(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "no_camera" : "failed");
        return;
      }
      if (stopped || !video.current) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
      if (track && caps.torch) setTorch({ on: false, track });
      let detector;
      try {
        detector = await barcodeDetector();
      } catch {
        setProblem("failed");
        return;
      }
      setReady(true);
      const look = async () => {
        if (stopped) return;
        const v = video.current;
        if (v && v.readyState >= 2) {
          try {
            const codes = await detector.detect(v);
            const code = codes.find((c) => c.rawValue.trim())?.rawValue.trim();
            const now = Date.now();
            if (code && (code !== last.code || now - last.at > 2500)) {
              last.code = code;
              last.at = now;
              beep();
              handler.current(code);
            } else if (code) last.at = now;
          } catch {
            // A frame it could not read: the next one.
          }
        }
        timer = setTimeout(() => void look(), 150);
      };
      void look();
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  const toggleTorch = () => {
    if (!torch) return;
    const on = !torch.on;
    void torch.track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).then(() => setTorch({ ...torch, on }));
  };

  if (problem) {
    return (
      <div className={cn("flex flex-col items-center gap-2 rounded-2xl bg-surface-2 px-4 py-6 text-center text-[13px] text-ink-2", className)} role="status">
        <VideoOff size={22} className="text-ink-3" />
        {t(`scan.problems.${problem}`)}
      </div>
    );
  }
  return (
    <div className={cn("relative overflow-hidden rounded-2xl bg-black", className)}>
      <video ref={video} muted playsInline className="aspect-[4/3] w-full object-cover" aria-label={t("scan.camera")} />
      {/* Where to hold the code. */}
      <div className="pointer-events-none absolute inset-x-[12%] top-1/2 h-[38%] -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgb(0_0_0/0.25)]" aria-hidden />
      <p className="absolute inset-x-0 bottom-2 text-center text-[12.5px] font-medium text-white drop-shadow" role="status">
        {ready ? t("scan.hint") : t("scan.starting")}
      </p>
      {torch && (
        <button type="button" onClick={toggleTorch} aria-pressed={torch.on} aria-label={t("scan.torch")} className={cn("press absolute top-2 right-2 inline-flex size-10 items-center justify-center rounded-full", torch.on ? "bg-white text-black" : "bg-black/50 text-white")}>
          <Flashlight size={18} />
        </button>
      )}
    </div>
  );
}
