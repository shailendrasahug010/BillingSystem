import { LoaderCircle } from "lucide-react";
import { useI18n } from "../../app/i18n";

/** Where reading a chosen file has got to: a photo or a scanned PDF takes a few seconds a page. */
export interface Reading {
  page: number;
  pages: number;
}

export function ReadingStatus({ reading }: { reading: Reading }) {
  const { t } = useI18n();
  return (
    <p className="flex items-center gap-2 text-[13.5px] text-ink-2" role="status">
      <LoaderCircle size={16} className="shrink-0 animate-spin text-accent" aria-hidden />
      {reading.pages > 1 ? t("imports.readingPage", { page: reading.page, pages: reading.pages }) : reading.pages === 1 ? t("imports.readingOnePage") : t("imports.reading")}
    </p>
  );
}
