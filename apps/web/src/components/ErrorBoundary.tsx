import { RotateCcw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "../app/i18n";
import { reportError } from "../lib/errorReport";
import { Button } from "./ui/Button";

interface State {
  error: Error | null;
  reference: string | null;
}

/** In development, where it broke (the first line of our code in the stack); a production stack says nothing useful here. */
function whereInDev(error: Error): string | null {
  if (!import.meta.env.DEV) return null;
  const frame = error.stack?.split("\n").find((l) => /\/src\//.test(l) && !l.includes("node_modules"));
  return frame?.trim().replace(/https?:\/\/[^/]+/, "").replace(/\?[^:]*/, "") ?? null;
}

function CrashNotice({ error, reference, onRetry }: { error: Error; reference: string | null; onRetry(): void }) {
  const { t } = useI18n();
  const where = whereInDev(error);
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-10 text-center shadow-card" role="alert">
      <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
        <TriangleAlert size={22} />
      </span>
      <h2 className="text-[18px] font-semibold text-ink">{t("crash.title")}</h2>
      <p className="text-[14px] text-ink-2">{t("crash.body")}</p>
      {reference && <p className="font-mono text-[12px] text-ink-3">{t("crash.reference", { ref: reference })}</p>}
      {where && (
        <p className="w-full rounded-lg bg-surface-2 px-3 py-2 text-left font-mono text-[12px] text-ink-2">
          {error.message}
          <br />
          {where}
        </p>
      )}
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={<RotateCcw size={16} />} onClick={onRetry}>
          {t("crash.retry")}
        </Button>
        <Button onClick={() => location.reload()}>{t("crash.reload")}</Button>
      </div>
    </div>
  );
}

/**
 * Keeps a crash inside one screen: the menu stays usable, the error goes to
 * the error log, and the person sees a reference to quote. Moving to another
 * screen (or Try again) starts it afresh.
 */
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, reference: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ reference: reportError(error, "render", info.componentStack ? { componentStack: info.componentStack } : {}) });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return <CrashNotice error={this.state.error} reference={this.state.reference} onRetry={() => this.setState({ error: null, reference: null })} />;
  }
}

/** The last resort around the whole app (it may have failed before the language was known: both languages). */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, reference: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ reference: reportError(error, "render", info.componentStack ? { componentStack: info.componentStack } : {}) });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-app-screen place-items-center bg-bg p-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center" role="alert">
          <h1 className="text-[20px] font-semibold text-ink">Digital Bahi stopped working · डिजिटल बही रुक गई</h1>
          <p className="text-[14px] text-ink-2">Something went wrong. It has been noted so it can be fixed. Reload to continue. · कुछ गड़बड़ हुई। इसे दर्ज कर लिया गया है। जारी रखने के लिए फिर से लोड करें।</p>
          {this.state.reference && <p className="font-mono text-[12px] text-ink-3">Reference · संदर्भ: {this.state.reference}</p>}
          <button type="button" className="mt-2 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-ink-inverse" onClick={() => location.reload()}>
            Reload · फिर से लोड करें
          </button>
        </div>
      </div>
    );
  }
}
